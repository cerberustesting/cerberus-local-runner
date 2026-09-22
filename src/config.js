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
    'robotproxy.enabled': 'false',
    'robotproxy.jar': 'cerberus-robot-proxy.jar',
    'robotproxy.port': '8093',
    // mitmproxy.app is a code-signed Developer ID bundle whose Python runtime only works
    // untouched - electron-builder's own re-signing pass can break it the same way jpackage's
    // did, so this stays a bare command name resolved via PATH unless pointed at an absolute path.
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
    if (!properties['runner.id'] || !properties['runner.id'].trim()) {
      properties['runner.id'] = 'local-' + crypto.randomUUID();
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