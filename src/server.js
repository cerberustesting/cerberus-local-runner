// HTTP API backing resources/index.html: same routes/JSON shapes the UI already expects.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const RESOURCES_DIR = path.join(__dirname, 'resources');

// Cerberus's robot.platform values follow Selenium's Platform enum naming (WINDOWS/MAC/LINUX).
// index.html forces a robot's platform to this before creating its "local-runner-{name}" clone,
// since a mismatch against the machine actually running Selenium here makes the Grid node reject
// every session request outright (capability match failure, not a slow timeout).
const RUNNER_PLATFORM = { darwin: 'MAC', win32: 'WINDOWS', linux: 'LINUX' }[process.platform] || process.platform.toUpperCase();

function send(res, status, contentType, body) {
  const bytes = Buffer.from(body, 'utf-8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': bytes.length,
  });
  res.end(bytes);
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { send(res, 404, 'text/plain; charset=utf-8', 'Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Content-Length': data.length });
    res.end(data);
  });
}

function callbackPage(success, message) {
  const color = success ? 'var(--crb-green-color)' : '#e63757';
  const autoClose = success ? '<script>setTimeout(function(){window.close();},1200);</script>' : '';
  return '<!doctype html><html><head><meta charset="utf-8"><title>Cerberus Local Runner</title>'
    + "<script>(function(){var t=localStorage.getItem('crb-theme');if(t)document.documentElement.setAttribute('data-theme',t);})();</script>"
    + '<style>'
    + ':root{color-scheme:light;--crb-bg:#f5f6fa;--crb-new-bg:rgba(255,255,255,.95);--crb-new-border:#dbe3ee;--crb-text:#1e293b;--crb-text-muted:#64748b;--crb-green-color:#10b981}'
    + '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--crb-bg:#1e222a;--crb-new-bg:rgba(30,41,59,.95);--crb-new-border:#334155;--crb-text:#f1f5f9;--crb-text-muted:#94a3b8;--crb-green-color:#34d399}}'
    + ':root[data-theme="dark"]{color-scheme:dark;--crb-bg:#1e222a;--crb-new-bg:rgba(30,41,59,.95);--crb-new-border:#334155;--crb-text:#f1f5f9;--crb-text-muted:#94a3b8;--crb-green-color:#34d399}'
    + 'body{font-family:Inter,system-ui,sans-serif;background:var(--crb-bg);color:var(--crb-text);'
    + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
    + '.box{max-width:420px;padding:28px;border-radius:16px;background:var(--crb-new-bg);border:1px solid var(--crb-new-border);text-align:center}'
    + 'h1{font-size:18px;margin:0 0 8px;color:' + color + '}p{color:var(--crb-text-muted);font-size:14px}</style></head>'
    + '<body><div class="box"><h1>' + (success ? 'Connected' : 'Sign-in failed') + '</h1><p>' + message + '</p></div></body>' + autoClose + '</html>';
}

function escapeHtml(value) {
  return value == null ? '' : String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function requirePost(req, res) {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return false; }
  return true;
}

function createServer(config, supervisor, auth, robots) {
  supervisor.onChange = () => {}; // callers (main.js) may override to push live updates

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (p === '/' && req.method === 'GET') {
        serveFile(res, path.join(RESOURCES_DIR, 'index.html'), 'text/html; charset=utf-8');
      } else if ((p === '/cerberus-logo.png' || p === '/cerberus_logo_light.png') && req.method === 'GET') {
        serveFile(res, path.join(RESOURCES_DIR, p.slice(1)), 'image/png');
      } else if (p === '/api/status' && req.method === 'GET') {
        sendJson(res, 200, { ...supervisor.status(robots), runnerPlatform: RUNNER_PLATFORM });
      } else if (p === '/api/logs' && req.method === 'GET') {
        sendJson(res, 200, supervisor.logs);
      } else if (p === '/api/start') {
        if (!requirePost(req, res)) return;
        supervisor.startAsync();
        sendJson(res, 202, { accepted: true });
      } else if (p === '/api/stop') {
        if (!requirePost(req, res)) return;
        supervisor.stop();
        sendJson(res, 202, { accepted: true });
      } else if (p.startsWith('/api/services/')) {
        if (!requirePost(req, res)) return;
        const [, , , service, action] = p.split('/');
        const methods = {
          selenium: { start: () => supervisor.startSelenium(), stop: () => supervisor.stopSelenium() },
          extension: { start: () => supervisor.startExtension(), stop: () => supervisor.stopExtension() },
          robotproxy: { start: () => supervisor.startRobotProxy(), stop: () => supervisor.stopRobotProxy() },
        };
        const fn = methods[service] && methods[service][action];
        if (!fn) { sendJson(res, 404, { error: 'not found' }); return; }
        fn();
        sendJson(res, 202, { accepted: true });
      } else if (p === '/api/robotproxy/enable') {
        if (!requirePost(req, res)) return;
        const body = JSON.parse(await readBody(req) || '{}');
        // index.html sends enabled as the string "true"/"false" (JSON.stringify of a string,
        // not a boolean) - compare case-insensitively rather than against the boolean literal.
        config.set('robotproxy.enabled', String(String(body.enabled).toLowerCase() === 'true'));
        config.save();
        sendJson(res, 200, { ok: true });
      } else if (p === '/api/browsers' && req.method === 'GET') {
        sendJson(res, 200, require('./browsers').detect());
      } else if (p === '/api/auth/status' && req.method === 'GET') {
        const status = await auth.status();
        sendJson(res, 200, { ...status, runnerName: robots.runnerName() });
      } else if (p === '/api/auth/apikey') {
        if (!requirePost(req, res)) return;
        const body = JSON.parse(await readBody(req) || '{}');
        try {
          sendJson(res, 200, await auth.saveApiKey(body.cerberusUrl, body.apiKey));
        } catch (exception) {
          sendJson(res, 400, { status: 'failed', message: exception.message });
        }
      } else if (p === '/api/auth/oauth/start') {
        if (!requirePost(req, res)) return;
        const body = JSON.parse(await readBody(req) || '{}');
        try {
          sendJson(res, 200, { authorizeUrl: await auth.startOAuth(body.cerberusUrl) });
        } catch (exception) {
          sendJson(res, 400, { error: exception.message });
        }
      } else if (p === '/api/auth/test') {
        if (!requirePost(req, res)) return;
        sendJson(res, 200, await auth.testConnection());
      } else if (p === '/api/auth/logout') {
        if (!requirePost(req, res)) return;
        auth.logout();
        sendJson(res, 200, { ok: true });
      } else if (p === '/oauth/callback' && req.method === 'GET') {
        try {
          const login = await auth.completeOAuth(url.searchParams.get('code'), url.searchParams.get('state'),
            url.searchParams.get('error'), url.searchParams.get('error_description'));
          send(res, 200, 'text/html; charset=utf-8', callbackPage(true,
            'Signed in' + (login ? ' as ' + escapeHtml(login) : '') + '. This tab will close automatically - if it doesn\'t, you can close it and return to the Cerberus Local Runner.'));
        } catch (exception) {
          send(res, 200, 'text/html; charset=utf-8', callbackPage(false, escapeHtml(exception.message)));
        }
      } else if (p.startsWith('/api/robots')) {
        await handleRobots(req, res, p, robots);
      } else {
        send(res, 404, 'text/plain; charset=utf-8', 'Not found');
      }
    } catch (exception) {
      sendJson(res, 502, { error: exception.message || String(exception) });
    }
  });
}

async function handleRobots(req, res, p, robots) {
  const remainder = p.slice('/api/robots'.length).replace(/^\//, '');
  try {
    if (req.method === 'POST' && remainder === 'select') {
      const body = JSON.parse(await readBody(req) || '{}');
      robots.select(body.robot);
      sendJson(res, 200, { ok: true });
    } else if (req.method === 'POST' && remainder === 'runnerName') {
      const body = JSON.parse(await readBody(req) || '{}');
      robots.setRunnerName(body.runnerName);
      sendJson(res, 200, { ok: true });
    } else if (req.method === 'POST' && remainder === '') {
      const result = await robots.createRobot(await readBody(req));
      send(res, result.status, 'application/json; charset=utf-8', result.body);
    } else if (req.method === 'DELETE' && remainder !== '') {
      const result = await robots.deleteRobot(remainder);
      send(res, result.status, 'application/json; charset=utf-8', result.body);
    } else if (req.method === 'GET' && remainder === '') {
      const result = await robots.listRobots();
      send(res, result.status, 'application/json; charset=utf-8', result.body);
    } else if (req.method === 'GET' && remainder !== '') {
      const result = await robots.getRobot(remainder);
      send(res, result.status, 'application/json; charset=utf-8', result.body);
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  } catch (exception) {
    sendJson(res, 502, { error: exception.message || String(exception) });
  }
}

module.exports = { createServer };