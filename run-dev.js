// Dev entry point: forces an own, throwaway config directory and mock.mode - never the real
// packaged app's (~/Library/Application Support/Cerberus Local Runner and friends), so `npm
// start` can't clobber a real run's saved credentials/robot/tunnels, and can't fight it over
// the same ui.port either.
'use strict';
const fs = require('fs');
const path = require('path');

const configDir = process.env.CRB_CONFIG_DIR || path.join(__dirname, '.dev-config');
process.env.CRB_CONFIG_DIR = configDir;
fs.mkdirSync(configDir, { recursive: true });

const configFile = path.join(configDir, 'config.properties');
const lines = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf-8').split(/\r?\n/) : [];

function setLine(key, value) {
  const idx = lines.findIndex(l => l.startsWith(key + '='));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
}

// CRB_MOCK=false launches the real bundled selenium-server.jar/cerberus-extension.jar/cloudflared
// (copied next to this file from ../build/input, see .gitignore - never committed) instead of the
// mock-component.js stand-ins.
setLine('mock.mode', process.env.CRB_MOCK === 'false' ? 'false' : 'true');
// CRB_UI_PORT=18080 matches the real app's port, which is what Keycloak's "cerberus-local-runner"
// client has registered as a valid OAuth redirect_uri - only safe to use when the real packaged
// app isn't running (same port, both would otherwise fight over the bind).
setLine('ui.port', process.env.CRB_UI_PORT || '18099');
fs.writeFileSync(configFile, lines.filter(Boolean).join('\n') + '\n');

require('./src/main.js');