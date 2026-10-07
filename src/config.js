// A flat key=value properties file, defaults, and path resolution for bundled component
// binaries relative to the app's own install dir.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function isWindows() {
  return process.platform === 'win32';
}

function defaults() {
  return {
    'ui.port': '18080',
    // Set from the Settings page: the UI port can only change when the app restarts (the window, the
    // OAuth redirect URI and the listening socket all use the current one), so it waits here.
    'ui.nextPort': '',
    // Bundled by fetch-dependencies.js (vendor/jre in dev, packaged app's resources root in
    // prod) - a whole directory, not a single file, but resolved the same way via component().
    'java.home': 'jre',
    'selenium.port': '4444',
    'selenium.jar': 'selenium-server.jar',
    'extension.jar': 'cerberus-extension.jar',
    'extension.port': '6555',
    'cloudflared.binary': isWindows() ? 'cloudflared.exe' : 'cloudflared',
    'cloudflared.mode': 'quick',
    'cloudflared.token': '',
    'cloudflared.publicUrl': '',
    'cloudflared.proxyPublicUrl': '',
    'cloudflared.extensionPublicUrl': '',
    // The Robot Proxy also hosts the relay Cerberus core runs service calls through, so it always
    // starts. relayToken is generated on first load; relayAllowedHosts (comma-separated patterns with
    // "*", empty = any host) restricts which hosts a relayed call may reach.
    'robotproxy.enabled': 'true',
    'robotproxy.relayToken': '',
    'robotproxy.relayAllowedHosts': '',
    // Authentication of the Robot Proxy (all its services): none | token | oauth.
    // token: authToken is the shared secret (empty = reuse relayToken).
    // oauth: the Robot Proxy validates Keycloak JWTs (oauthIssuerUri + oauthAudiences, optional browser
    // login of its UI with oauthUiClientId/Secret) and Cerberus gets its own token with the
    // client_credentials grant (oauthTokenUrl - empty = <issuer>/protocol/openid-connect/token -,
    // oauthClientId, oauthClientSecret).
    'robotproxy.authMode': 'none',
    'robotproxy.authToken': '',
    'robotproxy.oauthIssuerUri': '',
    'robotproxy.oauthAudiences': '',
    'robotproxy.oauthUiClientId': '',
    'robotproxy.oauthUiClientSecret': '',
    'robotproxy.oauthTokenUrl': '',
    'robotproxy.oauthClientId': '',
    'robotproxy.oauthClientSecret': '',
    'robotproxy.jar': 'cerberus-robot-proxy.jar',
    'robotproxy.port': '8093',
    // Port the proxy engine (mitmdump) listens on for the browser Selenium launches, sent to Cerberus
    // as the executor's browser proxy port.
    'robotproxy.browserProxyPort': '8888',
    // The proxy engine. The default (bare name) means "automatic": the mitmdump bundled with the app if
    // there is one (mitmproxy.app on macOS - untouched, its signature breaks if re-signed), else the one
    // in the PATH. An absolute path, or a bare name other than the default, is used as is.
    'mitmproxy.binary': isWindows() ? 'mitmdump.exe' : 'mitmdump',
    'cerberus.callbackUrl': '',
    'cerberus.callbackBearerToken': '',
    'runner.id': '',
    'autostart': 'false',
    'openBrowser': 'true',
    'mock.mode': 'false',

    'cerberus.url': '',
    'cerberus.auth.mode': '',
    'cerberus.auth.apiKey': '',
    'cerberus.auth.verified': '',
    'cerberus.auth.login': '',
    'cerberus.auth.oauth.keycloakUrl': '',
    'cerberus.auth.oauth.realm': '',
    'cerberus.auth.oauth.clientId': 'cerberus-local-runner',
    'cerberus.auth.oauth.accessToken': '',
    'cerberus.auth.oauth.refreshToken': '',
    'cerberus.auth.oauth.expiresAt': '0',
    'robot.name': '',
    'robot.runnerName': '',
  };
}

function parseProperties(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

function serializeProperties(map) {
  const lines = ['# Cerberus Local Runner'];
  for (const [key, value] of Object.entries(map)) lines.push(`${key}=${value}`);
  return lines.join('\n') + '\n';
}

function detectConfigDirectory() {
  const override = process.env.CRB_CONFIG_DIR;
  if (override && override.trim()) return override.trim();

  const home = os.homedir();
  if (isWindows()) {
    const appData = process.env.APPDATA;
    const base = appData && appData.trim() ? appData : path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'Cerberus Local Runner');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cerberus Local Runner');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(home, '.config');
  return path.join(base, 'cerberus-local-runner');
}

class RunnerConfig {
  constructor(properties, configFile, applicationDirectory) {
    this.properties = properties;
    this.configFile = configFile;
    this.applicationDirectory = applicationDirectory;
  }

  static load(applicationDirectory) {
    const configDirectory = detectConfigDirectory();
    fs.mkdirSync(configDirectory, { recursive: true });
    const configFile = path.join(configDirectory, 'config.properties');

    const properties = defaults();
    if (fs.existsSync(configFile)) {
      Object.assign(properties, parseProperties(fs.readFileSync(configFile, 'utf-8')));
    }
    if (properties['ui.nextPort'] && properties['ui.nextPort'].trim()) {
      properties['ui.port'] = properties['ui.nextPort'].trim();
      properties['ui.nextPort'] = '';
    }
    if (!properties['runner.id'] || !properties['runner.id'].trim()) {
      properties['runner.id'] = 'local-' + crypto.randomUUID();
    }
    if (!properties['robotproxy.relayToken'] || !properties['robotproxy.relayToken'].trim()) {
      properties['robotproxy.relayToken'] = crypto.randomBytes(24).toString('hex');
    }
    fs.writeFileSync(configFile, serializeProperties(properties));
    return new RunnerConfig(properties, configFile, applicationDirectory);
  }

  component(key) {
    const configured = this.get(key);
    return path.isAbsolute(configured) ? configured : path.normalize(path.join(this.applicationDirectory, configured));
  }

  get(key) {
    return (this.properties[key] || '').trim();
  }

  integer(key) {
    return parseInt(this.get(key), 10);
  }

  bool(key) {
    return this.get(key).toLowerCase() === 'true';
  }

  set(key, value) {
    this.properties[key] = value == null ? '' : value;
  }

  save() {
    fs.writeFileSync(this.configFile, serializeProperties(this.properties));
  }

  port() {
    return this.integer('ui.port');
  }
}

module.exports = { RunnerConfig };