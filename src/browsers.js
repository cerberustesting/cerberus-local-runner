// Best-effort, purely informational detection of common browsers installed on this machine,
// checked by well-known install location per OS.
'use strict';
const fs = require('fs');
const path = require('path');

function macAppExists(appName) {
  return fs.existsSync(path.join('/Applications', appName)) || fs.existsSync(path.join('/System/Applications', appName));
}

function detectMac() {
  return [
    { name: 'Chrome', available: macAppExists('Google Chrome.app') },
    { name: 'Firefox', available: macAppExists('Firefox.app') },
    { name: 'Edge', available: macAppExists('Microsoft Edge.app') },
    { name: 'Safari', available: macAppExists('Safari.app') },
  ];
}

function windowsExists(relativePath) {
  for (const envVar of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    const base = process.env[envVar];
    if (base && base.trim() && fs.existsSync(path.join(base, relativePath))) return true;
  }
  return false;
}

function detectWindows() {
  return [
    { name: 'Chrome', available: windowsExists(path.join('Google', 'Chrome', 'Application', 'chrome.exe')) },
    { name: 'Firefox', available: windowsExists(path.join('Mozilla Firefox', 'firefox.exe')) },
    { name: 'Edge', available: windowsExists(path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')) },
  ];
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(...executableNames) {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const name of executableNames) {
      if (isExecutable(path.join(dir, name))) return true;
    }
  }
  return false;
}

function detectLinux() {
  return [
    { name: 'Chrome', available: onPath('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser') },
    { name: 'Firefox', available: onPath('firefox', 'firefox-esr') },
    { name: 'Edge', available: onPath('microsoft-edge', 'microsoft-edge-stable') },
  ];
}

function detect() {
  if (process.platform === 'win32') return detectWindows();
  if (process.platform === 'darwin') return detectMac();
  return detectLinux();
}

module.exports = { detect };