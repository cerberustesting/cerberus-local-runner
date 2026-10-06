// Executes a Cerberus "application service" definition from this machine, so APIs that are only
// reachable from the enterprise network can be called through the local runner. Used by the
// Services view's Test button. Calls triggered by Cerberus core don't come through here: core
// resolves the request itself and sends it to the relay (relay.js). Only REST is supported.
'use strict';

const { executeHttp, HttpExecError } = require('./http-executor');

const CALL_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 1_000_000;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

class ServiceCallError extends Error {}

// Replaces %key% placeholders with the values of the active properties; unknown ones stay as-is.
function substitute(text, props) {
  if (text == null) return '';
  return String(text).replace(/%([^%\s]+)%/g, (match, key) => (key in props ? props[key] : match));
}

function activeItems(items) {
  return (items || []).filter(i => i && i.isActive !== false && i.key);
}

function buildRequest(service, propList) {
  if (!service || typeof service !== 'object') throw new ServiceCallError('Missing service definition');
  if (String(service.type || '').toUpperCase() !== 'REST') {
    throw new ServiceCallError('Only REST services can be called from the local runner (got ' + (service.type || 'no type') + ')');
  }
  const method = String(service.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new ServiceCallError('Unsupported HTTP method: ' + method);

  const props = {};
  activeItems(propList).forEach(p => { props[p.key] = p.value == null ? '' : String(p.value); });
  const sub = text => substitute(text, props);

  const target = sub(service.servicePath).trim();
  let url;
  try { url = new URL(target); } catch (e) { throw new ServiceCallError('Invalid service URL: ' + (target || '(empty)')); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ServiceCallError('Only http and https URLs are supported');

  const headers = {};
  activeItems(service.headers).forEach(h => { headers[sub(h.key)] = sub(h.value); });

  let body;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  if (hasBody && service.serviceRequest) {
    body = sub(service.serviceRequest);
  } else if (hasBody && activeItems(service.contents).length) {
    body = new URLSearchParams(activeItems(service.contents).map(c => [sub(c.key), sub(c.value)])).toString();
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return { method, url: url.toString(), headers, body, followRedirects: service.isFollowingRedirection !== false };
}

async function callService(service, propList) {
  const request = buildRequest(service, propList);
  const started = Date.now();
  try {
    const result = await executeHttp(
      { method: request.method, url: request.url, headers: request.headers, body: request.body == null ? undefined : Buffer.from(request.body), followRedirects: request.followRedirects },
      { timeoutMs: CALL_TIMEOUT_MS, acceptUnsignedSsl: false, maxBodyBytes: MAX_BODY_CHARS });
    const headers = {};
    result.headers.forEach(([name, value]) => { headers[name] = name in headers ? headers[name] + ', ' + value : value; });
    return {
      request: { method: request.method, url: request.url, headers: request.headers, body: request.body || '' },
      response: {
        status: result.status,
        statusText: result.statusText,
        headers,
        body: result.body.toString('utf-8'),
        truncated: result.truncated,
      },
      durationMs: Date.now() - started,
    };
  } catch (exception) {
    if (exception instanceof HttpExecError) throw new ServiceCallError(exception.message);
    throw exception;
  }
}

module.exports = { callService, ServiceCallError };
