// Runs one fully-built HTTP request from this machine: redirects, TLS verification, response
// decompression and size limits. Shared by the Services view's Test button (service-caller.js) and
// the relay Cerberus core calls through the tunnel (relay.js). Built on node's http/https rather
// than fetch because it needs per-request TLS verification, repeated response headers
// (Set-Cookie) and a DNS-level hook to refuse connections to the runner's own services.
'use strict';
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

const MAX_REDIRECTS = 10;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'proxy-connection', 'upgrade']);

class HttpExecError extends Error {
  // kind: 'timeout' | 'blocked' | 'connect'
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

function isLoopbackOrUnspecified(address) {
  const a = String(address).toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || a === '::' || a === '0.0.0.0' || a.startsWith('127.');
}

// guard(address, port) returns a reason string to refuse the connection, or null to allow it.
function checkTarget(guard, address, port) {
  const reason = guard ? guard(address, port) : null;
  return reason ? new HttpExecError(reason, 'blocked') : null;
}

function guardedLookup(guard, port) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, options, (error, address, family) => {
      if (error) return callback(error);
      const list = Array.isArray(address) ? address : [{ address, family }];
      for (const entry of list) {
        const blocked = checkTarget(guard, entry.address, port);
        if (blocked) return callback(blocked);
      }
      callback(null, address, family);
    });
  };
}

function decoderFor(response, method) {
  const noBody = method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304;
  const encoding = String(response.headers['content-encoding'] || '').toLowerCase().trim();
  if (noBody || !encoding) return { stream: response, decoded: false };
  if (encoding === 'gzip' || encoding === 'x-gzip') return { stream: response.pipe(zlib.createGunzip()), decoded: true };
  if (encoding === 'deflate') return { stream: response.pipe(zlib.createInflate()), decoded: true };
  if (encoding === 'br') return { stream: response.pipe(zlib.createBrotliDecompress()), decoded: true };
  return { stream: response, decoded: false };
}

function requestOnce(target, method, headers, body, options, signal) {
  return new Promise((resolve, reject) => {
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
      const blocked = checkTarget(options.guard, host, port);
      if (blocked) return reject(blocked);
    }
    const transport = target.protocol === 'https:' ? https : http;
    const requestOptions = {
      method, headers, signal,
      lookup: guardedLookup(options.guard, port),
      agent: false,
    };
    if (target.protocol === 'https:') requestOptions.rejectUnauthorized = !options.acceptUnsignedSsl;

    const request = transport.request(target, requestOptions, response => {
      const { stream, decoded } = decoderFor(response, method);
      const chunks = [];
      let size = 0;
      let truncated = false;
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true;
        if (error) return reject(error);
        resolve({
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          rawHeaders: response.rawHeaders,
          decoded,
          body: Buffer.concat(chunks),
          truncated,
        });
      };
      stream.on('data', chunk => {
        if (finished) return;
        size += chunk.length;
        if (size > options.maxBodyBytes) {
          chunks.push(chunk.subarray(0, chunk.length - (size - options.maxBodyBytes)));
          truncated = true;
          finish(); // before destroying: tearing the socket down raises 'aborted'
          response.destroy();
          stream.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      stream.on('end', () => finish());
      stream.on('error', finish);
      response.on('error', finish);
      response.on('aborted', () => finish(new Error('Connection closed before the response was complete')));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function headerEntries(headers) {
  const entries = [];
  for (const [name, value] of Object.entries(headers || {})) {
    for (const v of Array.isArray(value) ? value : [value]) entries.push([name, String(v)]);
  }
  return entries;
}

function firstHeader(rawHeaders, name) {
  for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name) return rawHeaders[i + 1];
  return undefined;
}

function removeHeader(headers, name) {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) delete headers[key];
}

/**
 * request: { method, url, headers: {name: value | [values]}, body: Buffer|undefined, followRedirects }
 * options: { timeoutMs, acceptUnsignedSsl, maxBodyBytes,
 *   guard(address, port) -> reason|null  (checked on every resolved address),
 *   checkUrl(url) -> reason|null          (checked on the initial URL and each redirect hop) }
 * Resolves { status, statusText, headers: [[name, value]...], body: Buffer, truncated, finalUrl }
 * with the response already decompressed (content-encoding / content-length removed).
 * Throws HttpExecError for timeouts, refused targets and connection failures.
 */
async function executeHttp(request, options) {
  const signal = AbortSignal.timeout(options.timeoutMs);
  let method = request.method;
  let target = new URL(request.url);
  let body = request.body;
  const headers = {};
  for (const [name, value] of headerEntries(request.headers)) {
    headers[name] = name in headers ? [].concat(headers[name], value) : value;
  }
  // Lets node set Content-Length itself; a stale one would corrupt a redirected/rewritten request.
  removeHeader(headers, 'content-length');
  removeHeader(headers, 'host');
  if (body && body.length) headers['Content-Length'] = String(body.length);

  try {
    for (let hop = 0; ; hop++) {
      const refused = options.checkUrl ? options.checkUrl(target) : null;
      if (refused) throw new HttpExecError(refused, 'blocked');
      const response = await requestOnce(target, method, headers, body, options, signal);
      const location = firstHeader(response.rawHeaders, 'location');
      const redirect = [301, 302, 303, 307, 308].includes(response.statusCode) && location;
      if (redirect && request.followRedirects !== false) {
        if (hop >= MAX_REDIRECTS) throw new HttpExecError('Too many redirects', 'connect');
        const next = new URL(location, target);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new HttpExecError('Redirect to unsupported protocol: ' + next.protocol, 'blocked');
        // Same rules as browsers/HttpClient: 303 (and 301/302 after a POST) become GET without body.
        if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET';
          body = undefined;
          removeHeader(headers, 'content-length');
          removeHeader(headers, 'content-type');
        }
        if (next.origin !== target.origin) removeHeader(headers, 'authorization');
        target = next;
        continue;
      }

      const out = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const name = response.rawHeaders[i];
        const lower = name.toLowerCase();
        if (HOP_BY_HOP.has(lower)) continue; // describes this connection, not the relayed body
        if (response.decoded && (lower === 'content-encoding' || lower === 'content-length')) continue;
        out.push([name, response.rawHeaders[i + 1]]);
      }
      return {
        status: response.statusCode,
        statusText: response.statusMessage || '',
        headers: out,
        body: response.body,
        truncated: response.truncated,
        finalUrl: target.toString(),
      };
    }
  } catch (exception) {
    if (exception instanceof HttpExecError) throw exception;
    if (signal.aborted || exception.name === 'AbortError' || exception.name === 'TimeoutError') {
      throw new HttpExecError('Timed out after ' + options.timeoutMs / 1000 + 's', 'timeout');
    }
    const code = exception.code ? ' (' + exception.code + ')' : '';
    throw new HttpExecError('Call failed: ' + (exception.message || exception) + code, 'connect');
  }
}

module.exports = { executeHttp, HttpExecError, isLoopbackOrUnspecified };
