// Orchestrated startup/shutdown of Selenium, the Cerberus Extension, cloudflared tunnels and the
// optional Robot Proxy, plus independent per-service restart. The log line format (timestamp +
// "[source] message") and JSON status shape are a fixed contract with resources/index.html.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
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
    return [this.javaBinary(), '-jar', jar, '--server.port=' + this.config.integer('robotproxy.port')];
  }

  mockCommand(component, port) {
    return [process.execPath, MOCK_SCRIPT, component, port];
  }

  javaBinary() {
    const javaHome = process.env.JAVA_HOME;
    if (!javaHome) throw new Error('JAVA_HOME is not set - required to launch the bundled Selenium/Extension/Robot Proxy jars');
    return path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
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
    const configured = this.config.component('mitmproxy.binary');
    if (!fs.existsSync(configured) || !fs.statSync(configured).isFile()) return; // bare command name: trust PATH.
    env.PATH = path.dirname(configured) + path.delimiter + (env.PATH || '');
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
    };
  }

  // Called on app quit - no orphaned Selenium/cloudflared/mitmdump processes left behind.
  shutdown() {
    this.stopProcesses();
  }
}

module.exports = { ProcessSupervisor };