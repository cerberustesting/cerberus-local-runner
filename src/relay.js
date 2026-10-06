// The single public entry point of the runner for Cerberus core (the "Proxy Service" of a robot
// executor): one listener behind one cloudflared tunnel that
//   - serves the relay: core resolves a service call itself (properties, auth, cookies) and has the
//     final HTTP request executed from this machine, so APIs only reachable on the runner's network
//     can be called. It is deliberately dumb: send the request, return the raw outcome.
//   - forwards every other path (including WebSocket upgrades) untouched to the Robot Proxy when
//     it is enabled, so core keeps talking to it exactly as before (/check, /startProxy, /getHar...).
// It has its own port because the UI server (server.js) is unauthenticated and must never be tunneled.
//
// Relay contract (JSON over HTTP, `Authorization: Bearer <relay.token>` required on both routes;
// the forwarded Robot Proxy paths keep their existing, unauthenticated behavior):
//   GET  /relay/check -> 200 { ok, version, runnerId }
//   POST /relay       <- { method, url, headers: {name: value | [values]}, bodyBase64?, followRedirects?,
//                          timeoutMs?, acceptUnsignedSsl? }
//                     -> 200 { status, statusText, headers: [[name, value]...], bodyBase64, truncated,
//                              durationMs, finalUrl }   (any status the *target* answered, 4xx/5xx included)
//   Relay-level failures are { error, code } with 400 invalid_request, 401 unauthorized,
//   403 target_blocked, 413 request_too_large, 429 too_many_requests, 502 connect_failed,
//   503 relay_stopped, 504 timeout. Response bodies are decompressed (no content-encoding/length).
'use strict';
const http = require('http');
const net = require('net');
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
    this.active = true; // the Services view can pause the relay alone, the gateway stays up
  }

  isListening() {
    return !!this.server && this.server.listening;
  }

  /** True when /relay actually serves calls. */
  isActive() {
    return this.isListening() && this.active && this.config.bool('relay.enabled');
  }

  setActive(active) {
    this.active = active;
  }

  start() {
    if (this.isListening()) return Promise.resolve();
    const token = this.config.get('relay.token');
    if (!token) return Promise.reject(new Error('relay.token is empty'));
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('upgrade', (req, socket, head) => this.forwardUpgrade(req, socket, head));
    this.server = server;
    this.active = true;
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
    if (path !== '/relay' && path !== '/relay/check') {
      this.forward(req, res);
      return;
    }
    try {
      if (!this.authorized(req)) throw new RelayError(401, 'unauthorized', 'Missing or invalid relay token');
      if (!this.isActive()) throw new RelayError(503, 'relay_stopped', 'The relay is stopped on this runner');
      if (path === '/relay/check' && req.method === 'GET') {
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

  robotProxyPort() {
    return this.config.bool('robotproxy.enabled') ? this.config.integer('robotproxy.port') : 0;
  }

  // Everything that is not the relay belongs to the Robot Proxy: pass it through as-is.
  forward(req, res) {
    const port = this.robotProxyPort();
    if (!port) return this.sendJson(res, 404, { error: 'Not found', code: 'not_found' });
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) this.sendJson(res, 502, { error: 'The Robot Proxy is not running on this runner', code: 'robotproxy_down' });
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  forwardUpgrade(req, socket, head) {
    const port = this.robotProxyPort();
    if (!port) { socket.destroy(); return; }
    const upstream = net.connect(port, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      upstream.write(raw + '\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
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
