#!/usr/bin/env node
// Downloads the real Selenium/Extension/cloudflared/Robot Proxy/mitmdump binaries into vendor/
// (gitignored - never committed) per dependencies.<os>.txt, the same manifest format the old
// jpackage build scripts used. The manifest's url side is free to point anywhere reachable with
// a plain GET (this delivery server, an artifact registry, a public release page): only the
// destination filename (the one config.js's defaults() expect) is fixed here.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const vendorDir = process.env.CRB_VENDOR_DIR || path.join(repoRoot, 'vendor');
const robotProxyEnabled = process.env.CERBERUS_ROBOT_PROXY === 'true';

// Temurin's mac archive wraps the JRE in a macOS bundle layout (Contents/Home) - Windows/Linux
// archives don't, their extracted top-level folder is JAVA_HOME directly.
const JRE_HOME_SUBPATH = { mac: ['Contents', 'Home'], windows: [], linux: [] };

const OS_KEY = process.env.CRB_BUILD_OS || { darwin: 'mac', win32: 'windows', linux: 'linux' }[process.platform];
if (!OS_KEY) {
  console.error(`Unsupported platform: ${process.platform} (set CRB_BUILD_OS to mac/windows/linux to override)`);
  process.exit(1);
}

const manifestFile = path.join(repoRoot, `dependencies.${OS_KEY}.txt`);

// [manifest key, destination filename, required]. mitmdump is a single file on Windows/Linux; on macOS
// it comes as the official mitmproxy.app bundle, installed untouched by installMitmproxyApp() below.
const FILES = [
  ['seleniumServer', 'selenium-server.jar', true],
  ['cerberusExtension', 'cerberus-extension.jar', true],
  ['cloudflared', OS_KEY === 'windows' ? 'cloudflared.exe' : 'cloudflared', true],
  ['cerberusRobotProxy', 'cerberus-robot-proxy.jar', robotProxyEnabled],
  ...(OS_KEY === 'mac' ? [] : [['mitmdump', OS_KEY === 'windows' ? 'mitmdump.exe' : 'mitmdump', robotProxyEnabled]]),
];

function parseManifest(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
        return;
      }
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

// Extracts the pinned Temurin JRE archive into vendor/jre - config.js's 'java.home' default
// expects a directory there, not a single file, so this can't go through the plain-copy FILES
// loop above. `tar -xf` (bsdtar) reads zip as readily as tar.gz and ships on Windows/macOS/Linux
// by default, so one extraction path covers every OS_KEY without a zip/tar-gz npm dependency.
async function installJre(manifest) {
  const url = manifest.jre;
  if (!url) throw new Error(`Missing dependency 'jre' in ${manifestFile}`);

  const archivePath = path.join(vendorDir, `jre-download.${OS_KEY === 'windows' ? 'zip' : 'tar.gz'}`);
  console.log(`Fetching jre <- ${url}`);
  await download(url, archivePath);

  const extractDir = path.join(vendorDir, '.jre-extract');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xf', archivePath, '-C', extractDir]);

  const [topLevelName] = fs.readdirSync(extractDir);
  const homeDir = path.join(extractDir, topLevelName, ...JRE_HOME_SUBPATH[OS_KEY]);

  const jreDir = path.join(vendorDir, 'jre');
  fs.rmSync(jreDir, { recursive: true, force: true });
  fs.renameSync(homeDir, jreDir);

  // Temurin ships some files read-only (e.g. the 0444 CDS archives lib/server/classes*.jsa);
  // macOS codesign has to write a signature into each file and fails with "Permission denied".
  if (OS_KEY === 'mac') execFileSync('chmod', ['-R', 'u+w', jreDir]);

  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(archivePath, { force: true });
}

// macOS: mitmdump is the official mitmproxy.app (a notarized bundle with its own Python.framework).
// Any change to it - a re-signature included, which is why package.json excludes it from signing -
// breaks the Python runtime ("different Team IDs"), so it is extracted as is, the download is checked
// against the pinned sha256, and the extracted bundle must still satisfy its own signature.
async function installMitmproxyApp(manifest) {
  const url = manifest.mitmproxyApp;
  if (!url) throw new Error(`Missing dependency 'mitmproxyApp' in ${manifestFile}`);
  const expected = (manifest.mitmproxyAppSha256 || '').toLowerCase();
  if (!expected) throw new Error(`Missing dependency 'mitmproxyAppSha256' in ${manifestFile}: the download is not pinned`);

  const archivePath = path.join(vendorDir, 'mitmproxy-download.tar.gz');
  const appDir = path.join(vendorDir, 'mitmproxy.app');
  try {
    console.log(`Fetching mitmproxy.app <- ${url}`);
    await download(url, archivePath);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    if (actual !== expected) {
      throw new Error(`mitmproxy.app download does not match its pinned sha256 (expected ${expected}, got ${actual})`);
    }

    fs.rmSync(appDir, { recursive: true, force: true });
    execFileSync('tar', ['-xzf', archivePath, '-C', vendorDir]);

    if (!fs.existsSync(path.join(appDir, 'Contents', 'MacOS', 'mitmdump'))) {
      throw new Error('mitmproxy.app was not extracted as expected: Contents/MacOS/mitmdump is missing');
    }
    if (process.platform === 'darwin') {
      try {
        execFileSync('codesign', ['--verify', '--deep', '--strict', appDir], { stdio: 'pipe' });
      } catch (error) {
        throw new Error(`mitmproxy.app does not satisfy its own code signature: ${String(error.stderr || error.message).trim()}`);
      }
    }
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

async function main() {
  if (!fs.existsSync(manifestFile)) throw new Error(`Missing dependency manifest: ${manifestFile}`);
  const manifest = parseManifest(fs.readFileSync(manifestFile, 'utf-8'));
  fs.mkdirSync(vendorDir, { recursive: true });

  for (const [key, destName, required] of FILES) {
    if (!required) continue;
    const url = manifest[key];
    if (!url) throw new Error(`Missing dependency '${key}' in ${manifestFile}`);
    const destination = path.join(vendorDir, destName);
    console.log(`Fetching ${destName} <- ${url}`);
    await download(url, destination);
    if (destName === 'cloudflared' || destName === 'mitmdump') fs.chmodSync(destination, 0o755);
  }
  if (OS_KEY === 'mac' && robotProxyEnabled) await installMitmproxyApp(manifest);
  await installJre(manifest);
  console.log(`Done - dependencies in ${vendorDir}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { installMitmproxyApp, parseManifest };