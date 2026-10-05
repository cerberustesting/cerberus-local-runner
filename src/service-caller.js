// Executes a Cerberus "application service" definition from this machine, so APIs that are only
// reachable from the enterprise network can be called through the local runner. Used by the
// Services view's Test button today; the same entry point is meant to be what Cerberus core
// triggers later. Only REST services are supported for now.
'use strict';

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      request: { method: request.method, url: request.url, headers: request.headers, body: request.body || '' },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text,
        truncated: text.length > MAX_BODY_CHARS,
      },
      durationMs: Date.now() - started,
    };
  } catch (exception) {
    if (exception.name === 'AbortError') throw new ServiceCallError('Timed out after ' + CALL_TIMEOUT_MS / 1000 + 's');
    // undici hides the real reason (DNS, refused, TLS...) in `cause`.
    const cause = exception.cause && (exception.cause.code || exception.cause.message);
    throw new ServiceCallError('Call failed: ' + exception.message + (cause ? ' (' + cause + ')' : ''));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callService, ServiceCallError };
