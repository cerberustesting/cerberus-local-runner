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

const repoRoot = path.join(__dirname, '..');
const vendorDir = path.join(repoRoot, 'vendor');
const robotProxyEnabled = process.env.CERBERUS_ROBOT_PROXY === 'true';

const OS_KEY = process.env.CRB_BUILD_OS || { darwin: 'mac', win32: 'windows', linux: 'linux' }[process.platform];
if (!OS_KEY) {
  console.error(`Unsupported platform: ${process.platform} (set CRB_BUILD_OS to mac/windows/linux to override)`);
  process.exit(1);
}

const manifestFile = path.join(repoRoot, `dependencies.${OS_KEY}.txt`);

// [manifest key, destination filename, required]. mitmdump is never bundled on mac (see
// config.js/README: jpackage's and electron-builder's own re-signing pass breaks its code
// signature) - install it separately (`brew install mitmproxy`) and point mitmproxy.binary at it.
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
  console.log(`Done - dependencies in ${vendorDir}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});