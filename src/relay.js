// The relay Cerberus core calls (through its own cloudflared tunnel) to have an HTTP request
// executed from this machine - for APIs only reachable on the runner's network. Core builds the
// final request (properties, auth, cookies already resolved) and this just sends it and returns
// the raw outcome, so it is deliberately dumb. It listens on its own port because the UI server
// (server.js) is unauthenticated and must never be exposed through a tunnel.
//
// Contract (JSON over HTTP, `Authorization: Bearer <relay.token>` required on every route):
//   GET  /check  -> 200 { ok, version, runnerId }
//   POST /relay  <- { method, url, headers: {name: value | [values]}, bodyBase64?, followRedirects?,
//                     timeoutMs?, acceptUnsignedSsl? }
//                -> 200 { status, statusText, headers: [[name, value]...], bodyBase64, truncated,
//                         durationMs, finalUrl }   (any status the *target* answered, 4xx/5xx included)
//   Relay-level failures are { error, code } with 400 invalid_request, 401 unauthorized,
//   403 target_blocked, 413 request_too_large, 429 too_many_requests, 502 connect_failed,
//   504 timeout. Response bodies are decompressed (no content-encoding/content-length headers).
'use strict';
const http = require('http');
const crypto = require('crypto');
const { executeHttp, HttpExecError, isLoopbackOrUnspecified } = require('./http-executor');

const RELAY_VERSION = 1;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_REQUEST_BYTES = 20 * 1024 * 1024; // JSON envelope, i.e. ~15 MB of base64-encoded body
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_IN_FLIGHT = 50;

class RelayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

// "*.corp.example.com, api.example.com" -> RegExps; an empty list means "any host".
function parseAllowedHosts(text) {
  return String(text || '').split(',').map(p => p.trim().toLowerCase()).filter(Boolean)
    .map(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
}

class RelayServer {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.server = null;
    this.inFlight = 0;
  }

  isListening() {
    return !!this.server && this.server.listening;
  }

  start() {
    if (this.isListening()) return Promise.resolve();
    const token = this.config.get('relay.token');
    if (!token) return Promise.reject(new Error('relay.token is empty'));
    const server = http.createServer((req, res) => this.handle(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.integer('relay.port'), '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  stop() {
    if (!this.server) return;
    this.server.close();
    this.server.closeAllConnections();
    this.server = null;
  }

  localUrl() {
    return `http://127.0.0.1:${this.config.integer('relay.port')}`;
  }

  authorized(req) {
    const header = String(req.headers.authorization || '');
    const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return crypto.timingSafeEqual(sha256(supplied), sha256(this.config.get('relay.token')));
  }

  async handle(req, res) {
    const path = (req.url || '').split('?')[0];
    try {
      if (!this.authorized(req)) throw new RelayError(401, 'unauthorized', 'Missing or invalid relay token');
      if (path === '/check' && req.method === 'GET') {
        return this.sendJson(res, 200, { ok: true, version: RELAY_VERSION, runnerId: this.config.get('runner.id') });
      }
      if (path === '/relay' && req.method === 'POST') {
        if (this.inFlight >= MAX_IN_FLIGHT) throw new RelayError(429, 'too_many_requests', 'Too many relayed calls in progress');
        this.inFlight++;
        try {
          return this.sendJson(res, 200, await this.relay(await this.readJson(req)));
        } finally {
          this.inFlight--;
        }
      }
      throw new RelayError(404, 'not_found', 'Unknown route');
    } catch (exception) {
      const error = exception instanceof RelayError ? exception : new RelayError(500, 'internal_error', exception.message || String(exception));
      this.sendJson(res, error.status, { error: error.message, code: error.code });
    }
  }

  readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) { reject(new RelayError(413, 'request_too_large', 'Relay request too large')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); }
        catch (e) { reject(new RelayError(400, 'invalid_request', 'Body is not valid JSON')); }
      });
      req.on('error', reject);
    });
  }

  sendJson(res, status, body) {
    const bytes = Buffer.from(JSON.stringify(body), 'utf-8');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
    res.end(bytes);
  }

  // Loopback addresses are only refused on this runner's own ports (UI, Selenium, Extension,
  // Robot Proxy, this relay): that is what a remote caller must never be able to reach, whereas an
  // API a tester runs on localhost is a legitimate target.
  ownPorts() {
    return ['ui.port', 'selenium.port', 'extension.port', 'robotproxy.port', 'relay.port'].map(k => this.config.integer(k));
  }

  async relay(input) {
    if (!input || typeof input !== 'object') throw new RelayError(400, 'invalid_request', 'Missing relay request');
    const method = String(input.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) throw new RelayError(400, 'invalid_request', 'Unsupported HTTP method: ' + method);
    let url;
    try { url = new URL(String(input.url || '')); } catch (e) { throw new RelayError(400, 'invalid_request', 'Invalid url'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RelayError(400, 'invalid_request', 'Only http and https URLs are supported');
    if (input.headers != null && (typeof input.headers !== 'object' || Array.isArray(input.headers))) throw new RelayError(400, 'invalid_request', 'headers must be an object');

    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const body = input.bodyBase64 ? Buffer.from(String(input.bodyBase64), 'base64') : undefined;
    const allowed = parseAllowedHosts(this.config.get('relay.allowedHosts'));
    const ownPorts = this.ownPorts();
    const started = Date.now();

    const options = {
      timeoutMs,
      acceptUnsignedSsl: input.acceptUnsignedSsl === true,
      maxBodyBytes: MAX_RESPONSE_BYTES,
      checkUrl: target => {
        const host = target.hostname.toLowerCase();
        return allowed.length && !allowed.some(re => re.test(host)) ? `Host ${host} is not in relay.allowedHosts` : null;
      },
      guard: (address, port) => isLoopbackOrUnspecified(address) && ownPorts.includes(port)
        ? `Refusing to reach the local runner's own service on port ${port}` : null,
    };

    try {
      const result = await executeHttp({ method, url: url.toString(), headers: input.headers || {}, body, followRedirects: input.followRedirects !== false }, options);
      const durationMs = Date.now() - started;
      this.log(`${method} ${url.origin}${url.pathname} -> ${result.status} (${durationMs}ms)`);
      return {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        bodyBase64: result.body.toString('base64'),
        truncated: result.truncated,
        durationMs,
        finalUrl: result.finalUrl,
      };
    } catch (exception) {
      if (!(exception instanceof HttpExecError)) throw exception;
      this.log(`${method} ${url.origin}${url.pathname} -> failed: ${exception.message}`);
      const mapped = { blocked: [403, 'target_blocked'], timeout: [504, 'timeout'], connect: [502, 'connect_failed'] }[exception.kind];
      throw new RelayError(mapped[0], mapped[1], exception.message);
    }
  }
}

module.exports = { RelayServer };
