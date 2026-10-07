// Orchestrated startup/shutdown of Selenium, the Cerberus Extension, cloudflared tunnels and the
// optional Robot Proxy, plus independent per-service restart. The log line format (timestamp +
// "[source] message") and JSON status shape are a fixed contract with resources/index.html.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const MOCK_SCRIPT = path.join(__dirname, 'mock-component.js');
const QUICK_TUNNEL_URL = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
const MAX_LOG_LINES = 500;

// Packaged, process.execPath is the Electron binary, not a plain Node runtime - only relevant to
// these JS mock stand-ins. Real Selenium/cloudflared/mitmdump binaries are spawned directly.
const MOCK_SPAWN_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

function isAlive(proc) {
  return !!proc && proc.exitCode === null && proc.signalCode === null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function messageOf(exception) {
  return exception && exception.message ? exception.message : String(exception);
}

class ProcessSupervisor {
  constructor(config) {
    this.config = config;
    this.state = 'STOPPED';
    this.logs = [];
    this.tunnelUrl = '';
    this.extensionTunnelUrl = '';
    this.proxyTunnelUrl = '';
    this.error = '';
    this.selenium = null;
    this.extension = null;
    this.cloudflared = null;
    this.cloudflaredExtension = null;
    this.robotproxy = null;
    this.cloudflaredProxy = null;
    this.seleniumBusy = false;
    this.extensionBusy = false;
    this.robotproxyBusy = false;
    this.robotproxyRestartPending = false; // settings saved while the Robot Proxy was busy
    this.onChange = () => {};
  }

  startAsync() {
    if (this.state !== 'STOPPED' && this.state !== 'ERROR') return;
    this.state = 'STARTING';
    this.error = '';
    this.tunnelUrl = '';
    this.extensionTunnelUrl = '';
    this.proxyTunnelUrl = '';
    this.onChange();
    this.startInternal().catch(() => {});
  }

  async startInternal() {
    try {
      this.log('runner', 'Starting Selenium');
      this.selenium = this.launch(this.seleniumCommand(), 'selenium', null);
      await this.waitForPort(this.config.integer('selenium.port'), 'selenium', this.selenium);
      this.log('runner', 'Selenium is ready at ' + this.seleniumLocalUrl());

      this.log('runner', 'Starting Cerberus Extension');
      this.extension = this.launch(this.extensionCommand(), 'extension', null);
      await this.waitForPort(this.config.integer('extension.port'), 'extension', this.extension);
      this.log('runner', 'Cerberus Extension is ready at ' + this.extensionLocalUrl());

      this.log('runner', 'Starting Cloudflare Tunnel');
      this.cloudflared = this.launch(this.cloudflaredCommand(this.seleniumLocalUrl()), 'cloudflared', url => { this.tunnelUrl = url; });
      this.tunnelUrl = await this.waitForTunnel(this.cloudflared, 'cloudflared.publicUrl', () => this.tunnelUrl);

      if (this.namedTunnelMode()) {
        this.extensionTunnelUrl = this.config.get('cloudflared.extensionPublicUrl');
        if (!this.extensionTunnelUrl) throw new Error('cloudflared.extensionPublicUrl is required in named mode');
      } else {
        this.log('runner', 'Starting Cloudflare Tunnel for Extension');
        this.cloudflaredExtension = this.launch(this.cloudflaredCommand(this.extensionLocalUrl()), 'cloudflared-extension', url => { this.extensionTunnelUrl = url; });
        this.extensionTunnelUrl = await this.waitForTunnel(this.cloudflaredExtension, null, () => this.extensionTunnelUrl);
      }

      if (this.config.bool('robotproxy.enabled')) {
        this.log('runner', 'Starting Cerberus Robot Proxy');
        this.robotproxy = this.launch(this.robotproxyCommand(), 'robotproxy', null);
        await this.waitForPort(this.config.integer('robotproxy.port'), 'robotproxy', this.robotproxy);
        this.log('runner', 'Robot Proxy is ready at ' + this.robotproxyLocalUrl());

        if (this.namedTunnelMode()) {
          this.proxyTunnelUrl = this.config.get('cloudflared.proxyPublicUrl');
          if (!this.proxyTunnelUrl) throw new Error('cloudflared.proxyPublicUrl is required in named mode when robotproxy.enabled is true');
        } else {
          this.log('runner', 'Starting Cloudflare Tunnel for Robot Proxy');
          this.cloudflaredProxy = this.launch(this.cloudflaredCommand(this.robotproxyLocalUrl()), 'cloudflared-proxy', url => { this.proxyTunnelUrl = url; });
          this.proxyTunnelUrl = await this.waitForTunnel(this.cloudflaredProxy, null, () => this.proxyTunnelUrl);
        }
      }

      this.state = 'READY';
      this.log('runner', 'Local runner is ready at ' + this.tunnelUrl);
      this.sendCallback('READY');
    } catch (exception) {
      this.error = messageOf(exception);
      this.state = 'ERROR';
      this.log('runner', 'Startup failed: ' + this.error);
      this.stopProcesses();
    }
    this.onChange();
  }

  stop() {
    if (this.state === 'STOPPED') return;
    this.state = 'STOPPING';
    this.sendCallback('STOPPING');
    this.onChange();
    this.stopProcesses();
    this.tunnelUrl = '';
    this.extensionTunnelUrl = '';
    this.proxyTunnelUrl = '';
    this.seleniumBusy = false;
    this.extensionBusy = false;
    this.robotproxyBusy = false;
    this.robotproxyRestartPending = false;
    this.state = 'STOPPED';
    this.log('runner', 'Stopped');
    this.onChange();
  }

  stopProcesses() {
    this.destroy(this.cloudflaredProxy, 'cloudflared-proxy');
    this.destroy(this.robotproxy, 'robotproxy');
    this.destroy(this.cloudflaredExtension, 'cloudflared-extension');
    this.destroy(this.cloudflared, 'cloudflared');
    this.destroy(this.extension, 'extension');
    this.destroy(this.selenium, 'selenium');
    this.cloudflaredProxy = null;
    this.robotproxy = null;
    this.cloudflaredExtension = null;
    this.cloudflared = null;
    this.extension = null;
    this.selenium = null;
  }

  destroy(proc, name) {
    if (!isAlive(proc)) return;
    proc.kill('SIGTERM');
    const timer = setTimeout(() => { if (isAlive(proc)) proc.kill('SIGKILL'); }, 3000);
    proc.once('exit', () => clearTimeout(timer));
    this.log('runner', 'Stopped ' + name);
  }

  // ---- Independent per-service restart ---------------------------------------------------

  namedTunnelMode() {
    return this.config.get('cloudflared.mode').toLowerCase() === 'named';
  }

  stopSelenium() {
    if (this.state !== 'READY' || this.seleniumBusy || !isAlive(this.selenium)) return;
    this.seleniumBusy = true;
    this.onChange();
    this.stopSeleniumInternal().catch(() => {});
  }

  async stopSeleniumInternal() {
    this.log('runner', 'Stopping Selenium');
    if (!this.namedTunnelMode()) {
      this.destroy(this.cloudflared, 'cloudflared');
      this.cloudflared = null;
      this.tunnelUrl = '';
    }
    this.destroy(this.selenium, 'selenium');
    this.selenium = null;
    this.seleniumBusy = false;
    this.onChange();
  }

  startSelenium() {
    if (this.state !== 'READY' || this.seleniumBusy || isAlive(this.selenium)) return;
    this.seleniumBusy = true;
    this.onChange();
    this.startSeleniumInternal().catch(() => {});
  }

  async startSeleniumInternal() {
    try {
      this.log('runner', 'Starting Selenium');
      this.selenium = this.launch(this.seleniumCommand(), 'selenium', null);
      await this.waitForPort(this.config.integer('selenium.port'), 'selenium', this.selenium);
      this.log('runner', 'Selenium is ready at ' + this.seleniumLocalUrl());
      if (!this.namedTunnelMode()) {
        this.cloudflared = this.launch(this.cloudflaredCommand(this.seleniumLocalUrl()), 'cloudflared', url => { this.tunnelUrl = url; });
        this.tunnelUrl = await this.waitForTunnel(this.cloudflared, null, () => this.tunnelUrl);
        this.log('runner', 'Selenium tunnel ready at ' + this.tunnelUrl);
      }
    } catch (exception) {
      this.error = 'Selenium start failed: ' + messageOf(exception);
      this.log('runner', this.error);
    } finally {
      this.seleniumBusy = false;
      this.onChange();
    }
  }

  stopExtension() {
    if (this.state !== 'READY' || this.extensionBusy || !isAlive(this.extension)) return;
    this.extensionBusy = true;
    this.onChange();
    this.stopExtensionInternal().catch(() => {});
  }

  async stopExtensionInternal() {
    this.log('runner', 'Stopping Cerberus Extension');
    if (!this.namedTunnelMode()) {
      this.destroy(this.cloudflaredExtension, 'cloudflared-extension');
      this.cloudflaredExtension = null;
      this.extensionTunnelUrl = '';
    }
    this.destroy(this.extension, 'extension');
    this.extension = null;
    this.extensionBusy = false;
    this.onChange();
  }

  startExtension() {
    if (this.state !== 'READY' || this.extensionBusy || isAlive(this.extension)) return;
    this.extensionBusy = true;
    this.onChange();
    this.startExtensionInternal().catch(() => {});
  }

  async startExtensionInternal() {
    try {
      this.log('runner', 'Starting Cerberus Extension');
      this.extension = this.launch(this.extensionCommand(), 'extension', null);
      await this.waitForPort(this.config.integer('extension.port'), 'extension', this.extension);
      this.log('runner', 'Cerberus Extension is ready at ' + this.extensionLocalUrl());
      if (!this.namedTunnelMode()) {
        this.cloudflaredExtension = this.launch(this.cloudflaredCommand(this.extensionLocalUrl()), 'cloudflared-extension', url => { this.extensionTunnelUrl = url; });
        this.extensionTunnelUrl = await this.waitForTunnel(this.cloudflaredExtension, null, () => this.extensionTunnelUrl);
        this.log('runner', 'Extension tunnel ready at ' + this.extensionTunnelUrl);
      }
    } catch (exception) {
      this.error = 'Extension start failed: ' + messageOf(exception);
      this.log('runner', this.error);
    } finally {
      this.extensionBusy = false;
      this.onChange();
    }
  }

  stopRobotProxy() {
    if (this.state !== 'READY' || this.robotproxyBusy || !isAlive(this.robotproxy)) return;
    this.robotproxyBusy = true;
    this.onChange();
    this.stopRobotProxyInternal().catch(() => {});
  }

  async stopRobotProxyInternal() {
    this.log('runner', 'Stopping Cerberus Robot Proxy');
    if (!this.namedTunnelMode()) {
      this.destroy(this.cloudflaredProxy, 'cloudflared-proxy');
      this.cloudflaredProxy = null;
      this.proxyTunnelUrl = '';
    }
    this.destroy(this.robotproxy, 'robotproxy');
    this.robotproxy = null;
    this.robotproxyBusy = false;
    this.onChange();
  }

  /** Applies new launch settings: the old process must be gone before the new one binds the port. */
  restartRobotProxy() {
    if (this.state !== 'READY') return;
    if (this.robotproxyBusy) { this.robotproxyRestartPending = true; return; } // applied when the current operation ends
    if (!isAlive(this.robotproxy)) { this.startRobotProxy(); return; }
    this.robotproxyBusy = true;
    this.onChange();
    this.restartRobotProxyInternal().catch(() => {});
  }

  async restartRobotProxyInternal() {
    this.log('runner', 'Restarting Cerberus Robot Proxy to apply its new settings');
    const old = this.robotproxy;
    if (!this.namedTunnelMode()) {
      this.destroy(this.cloudflaredProxy, 'cloudflared-proxy');
      this.cloudflaredProxy = null;
      this.proxyTunnelUrl = '';
    }
    this.destroy(old, 'robotproxy');
    this.robotproxy = null;
    await new Promise(resolve => {
      if (!isAlive(old)) return resolve();
      old.once('exit', resolve);
      setTimeout(resolve, 6000);
    });
    await this.startRobotProxyInternal(); // clears the busy flag, logs its own failures
  }

  startRobotProxy() {
    if (this.state !== 'READY' || this.robotproxyBusy || isAlive(this.robotproxy) || !this.config.bool('robotproxy.enabled')) return;
    this.robotproxyBusy = true;
    this.onChange();
    this.startRobotProxyInternal().catch(() => {});
  }

  async startRobotProxyInternal() {
    try {
      this.log('runner', 'Starting Cerberus Robot Proxy');
      this.robotproxy = this.launch(this.robotproxyCommand(), 'robotproxy', null);
      await this.waitForPort(this.config.integer('robotproxy.port'), 'robotproxy', this.robotproxy);
      this.log('runner', 'Robot Proxy is ready at ' + this.robotproxyLocalUrl());
      if (!this.namedTunnelMode()) {
        this.cloudflaredProxy = this.launch(this.cloudflaredCommand(this.robotproxyLocalUrl()), 'cloudflared-proxy', url => { this.proxyTunnelUrl = url; });
        this.proxyTunnelUrl = await this.waitForTunnel(this.cloudflaredProxy, null, () => this.proxyTunnelUrl);
        this.log('runner', 'Robot Proxy tunnel ready at ' + this.proxyTunnelUrl);
      }
    } catch (exception) {
      this.error = 'Robot Proxy start failed: ' + messageOf(exception);
      this.log('runner', this.error);
    } finally {
      this.robotproxyBusy = false;
      this.onChange();
      if (this.robotproxyRestartPending) {
        this.robotproxyRestartPending = false;
        this.restartRobotProxy();
      }
    }
  }

  // ---- command builders -----------------------------------------------------------------

  seleniumCommand() {
    if (this.config.bool('mock.mode')) return this.mockCommand('selenium', String(this.config.integer('selenium.port')));
    const jar = this.requireFile(this.config.component('selenium.jar'), 'Selenium Server JAR');
    return [this.javaBinary(), '-jar', jar, 'standalone', '--host', '127.0.0.1',
      '--port', String(this.config.integer('selenium.port')), '--selenium-manager', 'true'];
  }

  extensionCommand() {
    if (this.config.bool('mock.mode')) return this.mockCommand('extension', String(this.config.integer('extension.port')));
    const jar = this.requireFile(this.config.component('extension.jar'), 'Cerberus extension JAR');
    return [this.javaBinary(), '-Djava.awt.headless=false', '-jar', jar, '-p', String(this.config.integer('extension.port'))];
  }

  cloudflaredCommand(targetUrl) {
    if (this.config.bool('mock.mode')) return this.mockCommand('cloudflared', String(new URL(targetUrl).port));
    const binary = this.requireFile(this.config.component('cloudflared.binary'), 'cloudflared binary');
    if (this.namedTunnelMode()) {
      const token = this.config.get('cloudflared.token');
      if (!token) throw new Error('cloudflared.token is required in named mode');
      return [binary, 'tunnel', '--no-autoupdate', 'run', '--token', token];
    }
    return [binary, 'tunnel', '--no-autoupdate', '--url', targetUrl];
  }

  robotproxyCommand() {
    if (this.config.bool('mock.mode')) return this.mockCommand('robotproxy', String(this.config.integer('robotproxy.port')));
    const jar = this.requireFile(this.config.component('robotproxy.jar'), 'Cerberus Robot Proxy JAR');
    // The Robot Proxy hosts the relay (Cerberus core runs service calls through it): it needs the
    // shared token, and must never let a relayed call reach this app's own loopback services.
    const ownPorts = ['ui.port', 'selenium.port', 'extension.port'].map(key => this.config.integer(key));
    return [this.javaBinary(), '-jar', jar, '--server.port=' + this.config.integer('robotproxy.port'),
      '--relay.token=' + this.config.get('robotproxy.relayToken'),
      '--relay.blocked-local-ports=' + ownPorts.join(','),
      '--relay.allowed-hosts=' + this.config.get('robotproxy.relayAllowedHosts'),
      // Always the resolved path: a desktop-launched app has a short PATH, and an absolute path is unambiguous.
      '--mitmproxy.command=' + this.mitmdumpLocation().path,
      ...this.robotproxyAuthArgs()];
  }

  // ---- Ports (Settings page) --------------------------------------------------------------------

  static get PORT_FIELDS() {
    return [
      { field: 'selenium', key: 'selenium.port', label: 'Selenium', checkFree: true },
      { field: 'extension', key: 'extension.port', label: 'Extension', checkFree: true },
      { field: 'robotproxy', key: 'robotproxy.port', label: 'Web Proxy / API relay', checkFree: true },
      { field: 'browserProxy', key: 'robotproxy.browserProxyPort', label: 'Browser proxy', checkFree: false },
      { field: 'ui', key: 'ui.port', label: 'Interface', checkFree: true },
    ];
  }

  /** Changing a port while its service runs would leave the status pointing at the wrong place. */
  portsEditable() {
    return (this.state === 'STOPPED' || this.state === 'ERROR') && !this.seleniumBusy && !this.extensionBusy && !this.robotproxyBusy;
  }

  portsForUi() {
    const ports = {};
    for (const { field, key } of ProcessSupervisor.PORT_FIELDS) ports[field] = this.config.integer(key);
    const pending = this.config.get('ui.nextPort');
    if (pending) ports.ui = parseInt(pending, 10); // what the next launch will use
    return { ports, editable: this.portsEditable(), restartForUi: !!pending };
  }

  static isPortFree(port) {
    return new Promise(resolve => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
  }

  /** Validates then saves the ports; throws a message naming the faulty port. Returns portsForUi(). */
  async applyPorts(input) {
    if (!this.portsEditable()) throw new Error('Stop the local runner before changing ports.');
    const fields = ProcessSupervisor.PORT_FIELDS;
    const next = {};
    for (const { field, label } of fields) {
      const text = String(input[field] == null ? '' : input[field]).trim();
      if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 65535) throw new Error(`${label}: "${text}" is not a valid port (1-65535).`);
      next[field] = Number(text);
    }
    const seen = new Map();
    for (const { field, label } of fields) {
      if (seen.has(next[field])) throw new Error(`${label} and ${seen.get(next[field])} cannot use the same port (${next[field]}).`);
      seen.set(next[field], label);
    }
    const current = this.portsForUi().ports;
    // The interface port is held by this very app (and, once saved, the next one is already vetted).
    const unchanged = (field, port) => port === current[field] || (field === 'ui' && port === this.config.integer('ui.port'));
    for (const { field, label, checkFree } of fields) {
      if (checkFree && !unchanged(field, next[field]) && !(await ProcessSupervisor.isPortFree(next[field]))) {
        throw new Error(`${label}: port ${next[field]} is already in use on this machine.`);
      }
    }
    for (const { field, key } of fields) {
      if (field === 'ui') continue;
      this.config.set(key, String(next[field]));
    }
    this.config.set('ui.nextPort', next.ui === this.config.integer('ui.port') ? '' : String(next.ui));
    this.config.save();
    this.log('runner', 'Ports saved: ' + fields.map(({ field, label }) => `${label} ${next[field]}`).join(', '));
    return this.portsForUi();
  }

  // ---- Robot Proxy authentication -------------------------------------------------------------

  /**
   * The validated authentication settings; throws a message the UI shows as the startup error.
   * `get` reads a `robotproxy.*` key and defaults to the saved config (the settings form validates
   * candidate values before saving them).
   */
  authSettings(get = key => this.config.get(key)) {
    const mode = get('robotproxy.authMode').toLowerCase() || 'none';
    if (!['none', 'token', 'oauth'].includes(mode)) {
      throw new Error(`robotproxy.authMode must be none, token or oauth (got "${get('robotproxy.authMode')}")`);
    }
    const settings = { mode };
    if (mode === 'token') {
      // Empty = the Robot Proxy falls back on relay.token, the same secret Cerberus is given.
      settings.token = get('robotproxy.authToken') || get('robotproxy.relayToken');
    }
    if (mode === 'oauth') {
      const missing = ['oauthIssuerUri', 'oauthClientId', 'oauthClientSecret'].filter(key => !get('robotproxy.' + key));
      if (missing.length) throw new Error('OAuth requires ' + missing.map(key => 'robotproxy.' + key).join(', '));
      settings.issuerUri = get('robotproxy.oauthIssuerUri');
      settings.audiences = get('robotproxy.oauthAudiences');
      settings.tokenUrl = get('robotproxy.oauthTokenUrl')
        || settings.issuerUri.replace(/\/+$/, '') + '/protocol/openid-connect/token';
      settings.clientId = get('robotproxy.oauthClientId');
      settings.clientSecret = get('robotproxy.oauthClientSecret');
    }
    return settings;
  }

  /** What the settings form shows: everything but the secrets, only whether they are set. */
  authSettingsForUi() {
    const c = this.config;
    return {
      mode: c.get('robotproxy.authMode').toLowerCase() || 'none',
      hasToken: !!c.get('robotproxy.authToken'),
      issuerUri: c.get('robotproxy.oauthIssuerUri'),
      audiences: c.get('robotproxy.oauthAudiences'),
      tokenUrl: c.get('robotproxy.oauthTokenUrl'),
      clientId: c.get('robotproxy.oauthClientId'),
      hasClientSecret: !!c.get('robotproxy.oauthClientSecret'),
      uiClientId: c.get('robotproxy.oauthUiClientId'),
      hasUiClientSecret: !!c.get('robotproxy.oauthUiClientSecret'),
      running: isAlive(this.robotproxy),
    };
  }

  /**
   * Validates then saves the settings of the form. A secret left empty keeps the saved one;
   * `useRelayToken` drops the custom token. Settings of a mode that is not selected are kept.
   * Running Robot Proxy is restarted to apply them. Returns { restarted }.
   */
  applyAuthSettings(input) {
    const trimmed = value => (value == null ? undefined : String(value).trim());
    const next = {};
    next['robotproxy.authMode'] = (trimmed(input.mode) || 'none').toLowerCase();
    const plain = { issuerUri: 'oauthIssuerUri', audiences: 'oauthAudiences', tokenUrl: 'oauthTokenUrl', clientId: 'oauthClientId', uiClientId: 'oauthUiClientId' };
    for (const [field, key] of Object.entries(plain)) {
      if (trimmed(input[field]) !== undefined) next['robotproxy.' + key] = trimmed(input[field]);
    }
    const secrets = { token: 'authToken', clientSecret: 'oauthClientSecret', uiClientSecret: 'oauthUiClientSecret' };
    for (const [field, key] of Object.entries(secrets)) {
      if (trimmed(input[field])) next['robotproxy.' + key] = trimmed(input[field]);
    }
    if (input.useRelayToken) next['robotproxy.authToken'] = '';
    this.authSettings(key => (key in next ? next[key] : this.config.get(key))); // throws if invalid
    Object.entries(next).forEach(([key, value]) => this.config.set(key, value));
    this.config.save();
    this.log('runner', 'Robot Proxy authentication set to ' + next['robotproxy.authMode']);
    if (this.state === 'READY' && (isAlive(this.robotproxy) || this.robotproxyBusy)) {
      this.restartRobotProxy();
      return { restarted: true };
    }
    return { restarted: false };
  }

  robotproxyAuthArgs() {
    const auth = this.authSettings();
    const args = ['--robotproxy.auth.mode=' + auth.mode];
    if (auth.mode === 'token' && this.config.get('robotproxy.authToken')) {
      args.push('--robotproxy.auth.token=' + auth.token);
    }
    if (auth.mode === 'oauth') {
      args.push('--spring.security.oauth2.resourceserver.jwt.issuer-uri=' + auth.issuerUri);
      if (auth.audiences) args.push('--spring.security.oauth2.resourceserver.jwt.audiences=' + auth.audiences);
      else this.log('runner', 'Warning: robotproxy.oauthAudiences is empty, the Robot Proxy accepts any token of the realm');
      const uiClientId = this.config.get('robotproxy.oauthUiClientId');
      if (uiClientId) {
        args.push('--robotproxy.auth.oauth2.ui.client-id=' + uiClientId);
        const uiSecret = this.config.get('robotproxy.oauthUiClientSecret');
        if (uiSecret) args.push('--robotproxy.auth.oauth2.ui.client-secret=' + uiSecret);
      }
    }
    return args;
  }

  /**
   * What Cerberus needs on the robot executor to talk to this Robot Proxy. In "none" mode the
   * Robot Proxy still requires the relay token on /relay, which Cerberus sends as a Bearer token
   * (the other routes simply ignore it).
   */
  coreProxyAuth() {
    const auth = this.authSettings();
    if (auth.mode === 'oauth') {
      return {
        executorProxyAuthMode: 'OAUTH',
        executorProxyOauthTokenUrl: auth.tokenUrl,
        executorProxyOauthClientId: auth.clientId,
        executorProxyOauthClientSecret: auth.clientSecret,
      };
    }
    return {
      executorProxyAuthMode: 'TOKEN',
      executorProxyAuthToken: auth.mode === 'token' ? auth.token : this.config.get('robotproxy.relayToken'),
    };
  }

  mockCommand(component, port) {
    return [process.execPath, MOCK_SCRIPT, component, port];
  }

  javaBinary() {
    const javaHome = this.config.component('java.home');
    const binary = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    return this.requireFile(binary, 'Bundled Java runtime');
  }

  requireFile(filePath, description) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`${description} not found: ${filePath}`);
    return filePath;
  }

  // ---- process launch + log capture ------------------------------------------------------

  launch(command, name, onTunnelUrl) {
    const safeLogCommand = [...command];
    const tokenIndex = safeLogCommand.indexOf('--token');
    if (tokenIndex >= 0 && tokenIndex + 1 < safeLogCommand.length) safeLogCommand[tokenIndex + 1] = '********';
    const SECRET_ARGS = /^(--(?:relay\.token|robotproxy\.auth\.token|robotproxy\.auth\.oauth2\.ui\.client-secret))=/;
    for (let i = 0; i < safeLogCommand.length; i++) {
      const secret = SECRET_ARGS.exec(safeLogCommand[i]);
      if (secret) safeLogCommand[i] = secret[1] + '=********';
    }
    this.log('runner', 'Launch: ' + safeLogCommand.join(' '));

    const [command0, ...args] = command;
    const isMock = command0 === process.execPath;
    const env = isMock ? MOCK_SPAWN_ENV : { ...process.env };
    if (name === 'robotproxy' && !isMock) this.extendPathForMitmproxy(env);

    const proc = spawn(command0, args, { env });
    this.wireLogs(proc, name, onTunnelUrl);
    return proc;
  }

  extendPathForMitmproxy(env) {
    const located = this.mitmdumpLocation();
    if (!located.found || !path.isAbsolute(located.path)) return; // bare command name: trust PATH.
    env.PATH = path.dirname(located.path) + path.delimiter + (env.PATH || '');
  }

  // ---- Which mitmdump (the proxy engine) ----------------------------------------------------------

  /** Dirs searched for a bare command: the PATH, plus Homebrew's, which an app started from the Finder lacks. */
  static commandDirs() {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    return dirs;
  }

  static isFile(file) {
    try { return fs.statSync(file).isFile(); } catch (e) { return false; }
  }

  static findOnPath(name) {
    for (const dir of ProcessSupervisor.commandDirs()) {
      const candidate = path.join(dir, name);
      if (!ProcessSupervisor.isFile(candidate)) continue;
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (e) { /* not executable */ }
    }
    return null;
  }

  /**
   * The mitmdump to launch: { source: 'bundled' | 'custom' | 'path', path, found }.
   * "mitmproxy.binary" left at its default means automatic (bundled first, then the PATH); anything else
   * the user set is honored. The bundled one sits in the app resources: on macOS inside mitmproxy.app,
   * which must stay untouched.
   */
  mitmdumpLocation() {
    const configured = this.config.get('mitmproxy.binary');
    const defaultName = process.platform === 'win32' ? 'mitmdump.exe' : 'mitmdump';
    if (configured && configured !== defaultName) {
      if (configured.includes('/') || configured.includes('\\')) {
        const resolved = this.config.component('mitmproxy.binary');
        return { source: 'custom', path: resolved, found: ProcessSupervisor.isFile(resolved) };
      }
      const onPath = ProcessSupervisor.findOnPath(configured);
      return { source: 'custom', path: onPath || configured, found: !!onPath };
    }
    const bundled = [process.platform === 'darwin' ? path.join('mitmproxy.app', 'Contents', 'MacOS', 'mitmdump') : null, defaultName]
      .filter(Boolean)
      .map(relative => path.join(this.config.applicationDirectory, relative))
      .find(ProcessSupervisor.isFile);
    if (bundled) return { source: 'bundled', path: bundled, found: true };
    const onPath = ProcessSupervisor.findOnPath(defaultName);
    return { source: 'path', path: onPath || defaultName, found: !!onPath };
  }

  wireLogs(proc, source, onTunnelUrl) {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) this.consumeLogLine(source, line, onTunnelUrl);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', () => { if (buffer) this.consumeLogLine(source, buffer, onTunnelUrl); });
    proc.once('error', exception => this.log(source, 'Failed to start: ' + messageOf(exception)));
  }

  consumeLogLine(source, line, onTunnelUrl) {
    this.log(source, line);
    if (onTunnelUrl) {
      const match = QUICK_TUNNEL_URL.exec(line);
      if (match) onTunnelUrl(match[0]);
    }
  }

  async waitForPort(port, name, proc) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!isAlive(proc)) throw new Error(name + ' stopped during startup');
      const responded = await this.probeStatus(port);
      if (responded) {
        // A pre-existing, unrelated process already bound to this port would answer just as fast,
        // right before our own process fails to bind the same port and exits - give it a beat.
        await sleep(300);
        if (!isAlive(proc)) throw new Error(`${name} exited right after port ${port} answered - is another process already using it?`);
        return;
      }
      await sleep(500);
    }
    throw new Error(name + ' did not become ready within 30 seconds');
  }

  probeStatus(port) {
    return new Promise(resolve => {
      const req = require('http').get({ host: '127.0.0.1', port, path: '/status', timeout: 2000 }, res => {
        res.resume();
        resolve(true); // any HTTP response (even a 404) proves *some* process holds the port.
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
  }

  /** publicUrlConfigKey is non-null only for the main tunnel, which supports "named" mode reading
   *  a fixed public URL from config; the Robot Proxy's secondary tunnel is quick-mode only. */
  async waitForTunnel(tunnelProcess, publicUrlConfigKey, urlGetter) {
    if (publicUrlConfigKey && this.namedTunnelMode()) {
      const url = this.config.get(publicUrlConfigKey);
      if (!url) throw new Error(publicUrlConfigKey + ' is required in named mode');
      await sleep(1500);
      if (!isAlive(tunnelProcess)) throw new Error('cloudflared stopped during startup');
      return url;
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!isAlive(tunnelProcess)) throw new Error('cloudflared stopped during startup');
      const url = urlGetter();
      if (url) return url;
      await sleep(250);
    }
    throw new Error('Cloudflare Quick Tunnel URL was not received within 30 seconds');
  }

  sendCallback(callbackState) {
    const callbackUrl = this.config.get('cerberus.callbackUrl');
    if (!callbackUrl) return;
    const payload = JSON.stringify({
      runnerId: this.config.get('runner.id'),
      tunnelUrl: this.tunnelUrl,
      seleniumUrl: this.seleniumLocalUrl(),
      status: callbackState,
    });
    const headers = { 'Content-Type': 'application/json' };
    const bearer = this.config.get('cerberus.callbackBearerToken');
    if (bearer) headers.Authorization = 'Bearer ' + bearer;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    fetch(callbackUrl, { method: 'POST', headers, body: payload, signal: controller.signal })
      .then(response => this.log('callback', 'Cerberus callback returned HTTP ' + response.status))
      .catch(exception => this.log('callback', 'Callback failed: ' + messageOf(exception)))
      .finally(() => clearTimeout(timer));
  }

  seleniumLocalUrl() { return `http://127.0.0.1:${this.config.integer('selenium.port')}`; }
  robotproxyLocalUrl() { return `http://127.0.0.1:${this.config.integer('robotproxy.port')}`; }
  extensionLocalUrl() { return `http://127.0.0.1:${this.config.integer('extension.port')}`; }

  log(source, message) {
    this.logs.push(`${new Date().toISOString()} [${source}] ${message}`);
    while (this.logs.length > MAX_LOG_LINES) this.logs.shift();
    this.onChange();
  }

  // ---- status snapshot --------------------------------------------------------------------

  pidOf(proc) { return isAlive(proc) ? proc.pid : null; }

  status(robots) {
    return {
      state: this.state,
      runnerId: this.config.get('runner.id'),
      seleniumUrl: this.seleniumLocalUrl(),
      tunnelUrl: this.tunnelUrl,
      seleniumPid: this.pidOf(this.selenium),
      cloudflaredPid: this.pidOf(this.cloudflared),
      extensionUrl: this.extensionLocalUrl(),
      extensionPid: this.pidOf(this.extension),
      extensionTunnelUrl: this.extensionTunnelUrl,
      cloudflaredExtensionPid: this.pidOf(this.cloudflaredExtension),
      error: this.error,
      robotName: robots.selectedRobot(),
      robotproxyEnabled: this.config.bool('robotproxy.enabled'),
      robotproxyUrl: this.robotproxyLocalUrl(),
      proxyTunnelUrl: this.proxyTunnelUrl,
      robotproxyPid: this.pidOf(this.robotproxy),
      seleniumBusy: this.seleniumBusy,
      extensionBusy: this.extensionBusy,
      robotproxyBusy: this.robotproxyBusy,
      robotproxyAuthMode: this.config.get('robotproxy.authMode').toLowerCase() || 'none',
      browserProxyPort: this.config.integer('robotproxy.browserProxyPort'),
    };
  }

  // Called on app quit - no orphaned Selenium/cloudflared/mitmdump processes left behind.
  shutdown() {
    this.stopProcesses();
  }
}

module.exports = { ProcessSupervisor };