// Electron main process: wires config + auth + robots + supervisor to the local HTTP server,
// and opens the UI (resources/index.html) in a BrowserWindow.
'use strict';
const { app, BrowserWindow, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { RunnerConfig } = require('./config');
const { CerberusAuthService } = require('./auth');
const { CerberusRobotService } = require('./robots');
const { CerberusApiService } = require('./cerberus-api');
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
const cerberusApi = new CerberusApiService(auth);
const httpServer = createServer(config, supervisor, auth, robots, cerberusApi);

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 860,
    icon: appIconPath,
    // No native title bar (like Slack or Claude): the page draws its own drag regions, and the OS
    // keeps only its window buttons - the traffic lights on macOS, a transparent overlay elsewhere.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#64748b', height: 32 } }),
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

// Only meaningful when packaged: a dev run isn't signed/published, so there's nothing to check.
function configureAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => console.log('Checking for update'));
  autoUpdater.on('update-available', info => console.log(`Update available: ${info.version}`));
  autoUpdater.on('update-not-available', () => console.log('No update available'));
  autoUpdater.on('download-progress', progress => console.log(`Downloading update: ${progress.percent.toFixed(1)}%`));
  // autoInstallOnAppQuit takes it from here - installed silently next time the app quits normally.
  autoUpdater.on('update-downloaded', info => console.log(`Update ready, will install on quit: ${info.version}`));
  autoUpdater.on('error', error => console.error('Update error:', error));

  autoUpdater.checkForUpdatesAndNotify();
}

httpServer.listen(config.port(), '127.0.0.1', () => {
  console.log(`Cerberus Local Runner UI: http://127.0.0.1:${config.port()}`);
  console.log(`Configuration: ${config.configFile}`);
  app.whenReady().then(() => {
    // BrowserWindow's icon option doesn't drive the Dock icon on macOS - that needs its own call,
    // and only matters in dev (a packaged .app already gets it from Info.plist/CFBundleIconFile).
    if (process.platform === 'darwin' && app.dock && !app.isPackaged) app.dock.setIcon(appIconPath);
    createWindow();
    configureAutoUpdater();
    if (config.bool('autostart')) supervisor.startAsync();
  });
});

// electron-updater's autoInstallOnAppQuit hooks its own 'before-quit' listener to launch the
// installer, which needs the app to actually reach quit - a forced app.exit(0) here would skip
// that listener and silently drop any pending update.
let quitting = false;

app.on('before-quit', event => {
  if (quitting) return;

  event.preventDefault();
  quitting = true;
  supervisor.stop();
  httpServer.close(() => app.quit());
});

app.on('window-all-closed', () => app.quit());