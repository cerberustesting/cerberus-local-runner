// Authenticates the local runner against a Cerberus instance, either with a per-user API key
// (X-API-KEY) or via an OAuth Authorization Code + PKCE flow against Keycloak. Both credentials
// are only ever verified against /mcp: today it is the only Cerberus route that accepts either
// scheme outside of a browser session.
'use strict';
const crypto = require('crypto');

const TOKEN_EXPIRY_SKEW_SECONDS = 30;
const DEFAULT_CLIENT_ID = 'cerberus-local-runner';
const PENDING_TTL_MS = 600_000;
const FETCH_TIMEOUT_MS = 10_000;

function isBlank(value) {
  return value == null || value.trim() === '';
}

function normalizeUrl(url) {
  let trimmed = url.trim();
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) trimmed = 'https://' + trimmed;
  return trimmed;
}

function randomToken(byteLength) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function codeChallenge(codeVerifier) {
  return crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class CerberusAuthService {
  constructor(config) {
    this.config = config;
    this.pending = new Map();
  }

  async status() {
    const mode = this.config.get('cerberus.auth.mode');
    let authenticated;
    if (mode === 'apikey') {
      const verified = this.config.get('cerberus.auth.verified');
      authenticated = verified === 'ok' || verified === 'unknown';
    } else if (mode === 'oauth') {
      authenticated = await this.ensureValidOAuthSession();
    } else {
      authenticated = false;
    }
    return {
      cerberusUrl: this.config.get('cerberus.url'),
      mode,
      authenticated,
      login: this.config.get('cerberus.auth.login'),
      keycloakUrl: this.config.get('cerberus.auth.oauth.keycloakUrl'),
      realm: this.config.get('cerberus.auth.oauth.realm'),
      clientId: this.config.get('cerberus.auth.oauth.clientId'),
      redirectUri: this.redirectUri(),
    };
  }

  async authHeader() {
    const mode = this.config.get('cerberus.auth.mode');
    if (mode === 'apikey') return { name: 'X-API-KEY', value: this.config.get('cerberus.auth.apiKey') };
    if (mode === 'oauth') return { name: 'Authorization', value: 'Bearer ' + (await this.oauthAccessToken()) };
    return null;
  }

  async ensureValidOAuthSession() {
    if (isBlank(this.config.get('cerberus.auth.oauth.accessToken'))) return false;
    try {
      await this.oauthAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  async oauthAccessToken() {
    const expiresAt = parseInt(this.config.get('cerberus.auth.oauth.expiresAt'), 10) || 0;
    if (Date.now() / 1000 < expiresAt - TOKEN_EXPIRY_SKEW_SECONDS) {
      return this.config.get('cerberus.auth.oauth.accessToken');
    }
    await this.refreshOAuthToken();
    return this.config.get('cerberus.auth.oauth.accessToken');
  }

  async refreshOAuthToken() {
    const refreshToken = this.config.get('cerberus.auth.oauth.refreshToken');
    if (isBlank(refreshToken)) throw new Error('OAuth session expired; please sign in again');

    const tokenEndpoint = this.config.get('cerberus.auth.oauth.keycloakUrl') + '/realms/'
      + encodeURIComponent(this.config.get('cerberus.auth.oauth.realm')) + '/protocol/openid-connect/token';
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.get('cerberus.auth.oauth.clientId'),
    });

    const response = await fetchWithTimeout(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (response.status !== 200) {
      this.config.set('cerberus.auth.oauth.accessToken', '');
      this.config.set('cerberus.auth.oauth.refreshToken', '');
      this.config.set('cerberus.auth.oauth.expiresAt', '0');
      this.config.save();
      throw new Error('OAuth session expired; please sign in again');
    }

    const body = await response.json();
    if (!body.access_token) throw new Error('Keycloak refresh response did not contain an access_token');

    const expiresAt = Math.floor(Date.now() / 1000) + (body.expires_in || 60);
    this.config.set('cerberus.auth.oauth.accessToken', body.access_token);
    this.config.set('cerberus.auth.oauth.refreshToken', body.refresh_token || refreshToken);
    this.config.set('cerberus.auth.oauth.expiresAt', String(expiresAt));
    this.config.save();
  }

  cerberusUrl() {
    return this.config.get('cerberus.url');
  }

  redirectUri() {
    return `http://127.0.0.1:${this.config.port()}/oauth/callback`;
  }

  // ---- API key mode -------------------------------------------------------

  async saveApiKey(cerberusUrl, apiKey) {
    if (isBlank(cerberusUrl)) throw new Error('Cerberus URL is required');
    if (isBlank(apiKey)) throw new Error('API key is required');
    this.config.set('cerberus.url', normalizeUrl(cerberusUrl));
    this.config.set('cerberus.auth.mode', 'apikey');
    this.config.set('cerberus.auth.apiKey', apiKey.trim());
    this.config.save();
    return this.testConnection();
  }

  // ---- OAuth mode ---------------------------------------------------------

  async startOAuth(cerberusUrl) {
    if (isBlank(cerberusUrl)) throw new Error('Cerberus URL is required');
    const normalizedCerberus = normalizeUrl(cerberusUrl);
    const oauthConfig = await this.fetchOAuthConfig(normalizedCerberus);

    this.config.set('cerberus.url', normalizedCerberus);
    this.config.set('cerberus.auth.oauth.keycloakUrl', oauthConfig.keycloakUrl);
    this.config.set('cerberus.auth.oauth.realm', oauthConfig.realm);
    this.config.set('cerberus.auth.oauth.clientId', oauthConfig.clientId);
    this.config.save();

    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, value] of this.pending) if (value.createdAt < cutoff) this.pending.delete(key);

    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    const challenge = codeChallenge(codeVerifier);
    const redirect = this.redirectUri();

    this.pending.set(state, {
      keycloakUrl: oauthConfig.keycloakUrl, realm: oauthConfig.realm, clientId: oauthConfig.clientId,
      redirectUri: redirect, codeVerifier, createdAt: Date.now(),
    });

    const authorizeEndpoint = oauthConfig.keycloakUrl + '/realms/' + encodeURIComponent(oauthConfig.realm) + '/protocol/openid-connect/auth';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: oauthConfig.clientId,
      redirect_uri: redirect,
      scope: 'openid profile email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return authorizeEndpoint + '?' + params.toString();
  }

  async fetchOAuthConfig(cerberusUrl) {
    let response;
    try {
      response = await fetchWithTimeout(cerberusUrl + '/api/public/oauth-config', { headers: { Accept: 'application/json' } }, 8000);
    } catch (exception) {
      throw new Error(`Could not reach Cerberus at ${cerberusUrl} to fetch its OAuth configuration: ${exception.message}`);
    }
    if (response.status !== 200) {
      throw new Error(`Cerberus did not return an OAuth configuration (HTTP ${response.status}). Check the Cerberus URL, or use an API key instead if this instance doesn't support sign-in yet.`);
    }
    const body = await response.json();
    if (!body.enabled || isBlank(body.keycloakUrl) || isBlank(body.realm)) {
      throw new Error('OAuth sign-in is not enabled on this Cerberus instance; use an API key instead');
    }
    return {
      keycloakUrl: normalizeUrl(body.keycloakUrl),
      realm: body.realm.trim(),
      clientId: isBlank(body.localRunnerClientId) ? DEFAULT_CLIENT_ID : body.localRunnerClientId.trim(),
    };
  }

  async completeOAuth(code, state, errorParam, errorDescription) {
    if (!isBlank(errorParam)) {
      throw new Error(`Keycloak returned an error: ${errorParam}${isBlank(errorDescription) ? '' : ` (${errorDescription})`}`);
    }
    if (state == null) throw new Error('Missing OAuth state');
    const request = this.pending.get(state);
    this.pending.delete(state);
    if (!request) throw new Error('Unknown or expired sign-in attempt; please retry');
    if (isBlank(code)) throw new Error('Keycloak did not return an authorization code');

    const tokenEndpoint = request.keycloakUrl + '/realms/' + encodeURIComponent(request.realm) + '/protocol/openid-connect/token';
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: request.redirectUri,
      client_id: request.clientId,
      code_verifier: request.codeVerifier,
    });
    const response = await fetchWithTimeout(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const responseText = await response.text();
    if (response.status !== 200) throw new Error(`Token exchange failed: HTTP ${response.status} ${responseText}`);

    const body = JSON.parse(responseText);
    if (!body.access_token) throw new Error('Keycloak response did not contain an access_token');

    const expiresAt = Math.floor(Date.now() / 1000) + (body.expires_in || 60);
    const login = await this.fetchUserLogin(request.keycloakUrl, request.realm, body.access_token);

    this.config.set('cerberus.auth.mode', 'oauth');
    this.config.set('cerberus.auth.oauth.accessToken', body.access_token);
    this.config.set('cerberus.auth.oauth.refreshToken', body.refresh_token || '');
    this.config.set('cerberus.auth.oauth.expiresAt', String(expiresAt));
    this.config.set('cerberus.auth.login', login || '');
    this.config.save();
    return login;
  }

  async fetchUserLogin(keycloakUrl, realm, accessToken) {
    try {
      const userInfoEndpoint = keycloakUrl + '/realms/' + encodeURIComponent(realm) + '/protocol/openid-connect/userinfo';
      const response = await fetchWithTimeout(userInfoEndpoint, { headers: { Authorization: 'Bearer ' + accessToken } }, 8000);
      if (response.status === 200) {
        const body = await response.json();
        return body.preferred_username || body.email || null;
      }
    } catch {
      // Best-effort only: the access token is still stored and usable without a display name.
    }
    return null;
  }

  // ---- connection test (against /mcp, the only route accepting either scheme today) -----

  async testConnection() {
    const cerberusUrl = this.config.get('cerberus.url');
    if (isBlank(cerberusUrl)) return { status: 'failed', message: 'Set a Cerberus URL first' };
    const mode = this.config.get('cerberus.auth.mode');
    let authHeader;
    try {
      authHeader = await this.authHeader();
    } catch (exception) {
      return { status: 'failed', message: exception.message };
    }
    if (!authHeader) return { status: 'failed', message: 'No credentials saved yet' };

    let result;
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cerberus-local-runner', version: '1.0' } },
      });
      const response = await fetchWithTimeout(cerberusUrl + '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          [authHeader.name]: authHeader.value,
        },
        body,
      });
      if (response.status === 200) {
        result = { status: 'ok', message: 'Connected' + this.loginSuffix() };
      } else if (response.status === 401) {
        result = { status: 'failed', message: 'Unauthorized: credentials were rejected by Cerberus' };
      } else if (response.status === 403) {
        result = { status: 'unknown', message: 'Saved. Could not verify: the MCP endpoint is disabled on this Cerberus instance (cerberus_mcp_enable parameter)' };
      } else {
        result = { status: 'failed', message: `Unexpected response: HTTP ${response.status}` };
      }
    } catch (exception) {
      result = { status: 'failed', message: `Connection failed: ${exception.message}` };
    }

    if (mode === 'apikey') {
      this.config.set('cerberus.auth.verified', result.status);
      this.config.save();
    }
    return result;
  }

  loginSuffix() {
    const login = this.config.get('cerberus.auth.login');
    return isBlank(login) ? '' : ' as ' + login;
  }

  logout() {
    this.config.set('cerberus.auth.mode', '');
    this.config.set('cerberus.auth.apiKey', '');
    this.config.set('cerberus.auth.verified', '');
    this.config.set('cerberus.auth.login', '');
    this.config.set('cerberus.auth.oauth.accessToken', '');
    this.config.set('cerberus.auth.oauth.refreshToken', '');
    this.config.set('cerberus.auth.oauth.expiresAt', '0');
    this.config.save();
  }
}

module.exports = { CerberusAuthService };