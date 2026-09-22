// Electron main process: wires config + auth + robots + supervisor to the local HTTP server,
// and opens the UI (resources/index.html) in a BrowserWindow.
'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { RunnerConfig } = require('./config');
const { CerberusAuthService } = require('./auth');
const { CerberusRobotService } = require('./robots');
const { ProcessSupervisor } = require('./supervisor');
const { createServer } = require('./server');

// electron-builder's per-platform "icon" config (package.json) only brands the packaged app
// bundle (Info.plist/.exe resource) - it has no effect on `npm start`/run-dev.js, where Electron
// otherwise shows its own default icon in the Dock/taskbar and window title bar.
const appIconPath = path.join(__dirname, '..', 'build-resources', 'icon.png');

// In dev, real (non-mock) component binaries live in vendor/ (gitignored, populated by
// `npm run fetch-deps`) - packaged, electron-builder's extraResources puts the same files at
// the app's own resources root instead.
const applicationDirectory = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'vendor');
const config = RunnerConfig.load(applicationDirectory);
const auth = new CerberusAuthService(config);
const robots = new CerberusRobotService(config, auth);
const supervisor = new ProcessSupervisor(config);
const httpServer = createServer(config, supervisor, auth, robots);

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 860,
    icon: appIconPath,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${config.port()}/`);

  // startOAuth() in index.html does window.open('', '_blank') then either navigates that popup
  // or (if it came back null) reopens with the real authorizeUrl - denying window creation here
  // always takes the second path, so Keycloak sign-in opens in the user's actual system browser
  // instead of a separate Electron window with its own, unrelated cookie jar/SSO session.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url !== 'about:blank') shell.openExternal(url);
    return { action: 'deny' };
  });
}

httpServer.listen(config.port(), '127.0.0.1', () => {
  console.log(`Cerberus Local Runner UI: http://127.0.0.1:${config.port()}`);
  console.log(`Configuration: ${config.configFile}`);
  app.whenReady().then(() => {
    // BrowserWindow's icon option doesn't drive the Dock icon on macOS - that needs its own call,
    // and only matters in dev (a packaged .app already gets it from Info.plist/CFBundleIconFile).
    if (process.platform === 'darwin' && app.dock && !app.isPackaged) app.dock.setIcon(appIconPath);
    createWindow();
    if (config.bool('autostart')) supervisor.startAsync();
  });
});

app.on('before-quit', event => {
  event.preventDefault();
  supervisor.stop();
  httpServer.close(() => app.exit(0));
});

app.on('window-all-closed', () => app.quit());