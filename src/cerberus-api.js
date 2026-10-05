// Thin pass-through to the Cerberus public API for the "Run" view: the catalogue lookups
// (applications, tests, testcases, countries, environments) and the queued-execution launch.
// Like robots.js, the response status/body are forwarded byte-for-byte.
'use strict';

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class CerberusApiService {
  constructor(auth) {
    this.auth = auth;
  }

  get(pathname) {
    return this.call('GET', pathname);
  }

  post(pathname, rawBody) {
    return this.call('POST', pathname, rawBody);
  }

  put(pathname, rawBody) {
    return this.call('PUT', pathname, rawBody);
  }

  async call(method, pathname, rawBody) {
    const authHeader = await this.auth.authHeader();
    const cerberusUrl = this.auth.cerberusUrl();
    if (!cerberusUrl) return { status: 400, body: '{"error":"Set a Cerberus URL first"}' };
    if (!authHeader) return { status: 401, body: '{"error":"Not authenticated"}' };

    const headers = { Accept: 'application/json', 'X-API-VERSION': '1', [authHeader.name]: authHeader.value };
    if (rawBody !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchWithTimeout(cerberusUrl + pathname, { method, headers, body: rawBody });
    return { status: response.status, body: await response.text() };
  }
}

module.exports = { CerberusApiService };
