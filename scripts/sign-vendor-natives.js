#!/usr/bin/env node
// macOS only. Signs the native Mach-O binaries (.dylib/.jnilib/.so/executables) that live INSIDE the
// vendored jars (OpenCV/OpenBLAS/JavaCPP/JNA in the extension, selenium-manager in Selenium, ffmpeg
// and netty in the Robot Proxy). electron-builder only signs files on disk, but Apple's notary
// service opens archives and rejects the whole app if any binary inside is unsigned, lacks a secure
// timestamp or the hardened runtime. Run after fetch-deps and before electron-builder.
//
// Identity: SIGN_IDENTITY (name or hash, "-" = ad-hoc, for local tests) from the default keychain,
// else CSC_LINK/CSC_KEY_PASSWORD (same secrets as electron-builder) imported into a throwaway
// keychain. With neither, this is a no-op so unsigned local builds keep working.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const vendorDir = process.env.CRB_VENDOR_DIR || path.join(__dirname, '..', 'vendor');
const ZIP_MAGIC = Buffer.from('PK\x03\x04', 'latin1');
const BATCH = 50;

if (process.platform !== 'darwin') {
  console.log('sign-vendor-natives: not macOS, nothing to do');
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 1 << 28, ...opts });
}

function isMachO(file) {
  if (file.endsWith('.class')) return false; // Java class files share the fat-binary magic 0xCAFEBABE
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(8);
  const n = fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  if (n < 8) return false;
  const magic = head.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  // fat binary: nfat_arch is a small count, whereas a class file has its (>= 45) version here
  return (magic === 0xcafebabe || magic === 0xcafebabf) && head.readUInt32BE(4) < 20;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function codesign(files, signing) {
  const adhoc = signing.identity === '-';
  for (let i = 0; i < files.length; i += BATCH) {
    for (const f of files.slice(i, i + BATCH)) fs.chmodSync(f, fs.statSync(f).mode | 0o200); // read-only files can't take a signature
    run('codesign', [
      '--force', '--sign', signing.identity,
      ...(signing.keychain ? ['--keychain', signing.keychain] : []),
      adhoc ? '--timestamp=none' : '--timestamp', '--options', 'runtime',
      ...files.slice(i, i + BATCH),
    ]);
  }
}

// Signs every Mach-O inside the zip/jar (recursing into nested jars) and updates it in place.
// Returns true if the archive was modified.
function processArchive(archive, signing, label) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crb-sign-'));
  try {
    // Selenium's jar is `cat launcher.sh app.jar`: zip(1) refuses to update it, so work on the
    // zip proper and put the launcher back afterwards (offsets are relative to the zip start).
    const raw = fs.readFileSync(archive);
    const zipStart = raw.subarray(0, 1 << 16).indexOf(ZIP_MAGIC);
    if (zipStart < 0) throw new Error(`${archive}: not a zip`);
    const zipFile = path.join(work, 'archive.zip');
    fs.writeFileSync(zipFile, raw.subarray(zipStart));

    const content = path.join(work, 'content');
    fs.mkdirSync(content);
    try {
      run('unzip', ['-q', '-o', zipFile, '-d', content]);
    } catch (e) {
      if (e.status !== 1) throw e; // 1 = warnings only
    }

    const files = walk(content);
    const natives = files.filter(isMachO);
    const nestedJars = [];
    for (const jar of files.filter((f) => f.endsWith('.jar'))) {
      if (processArchive(jar, signing, `${label}!${path.relative(content, jar)}`)) nestedJars.push(jar);
    }
    if (!natives.length && !nestedJars.length) return false;

    if (natives.length) {
      console.log(`${label}: signing ${natives.length} binaries`);
      codesign(natives, signing);
      // Re-adding replaces the stored entry (the file is now newer than the archive's copy).
      run('zip', ['-q', '-u', zipFile, '-@'], { cwd: content, input: natives.map((f) => path.relative(content, f)).join('\n') });
    }
    if (nestedJars.length) {
      // Spring Boot's loader requires nested jars to stay STORED (-0)
      run('zip', ['-q', '-0', '-u', zipFile, '-@'], { cwd: content, input: nestedJars.map((f) => path.relative(content, f)).join('\n') });
    }

    fs.writeFileSync(archive, Buffer.concat([raw.subarray(0, zipStart), fs.readFileSync(zipFile)]));
    return true;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function setupSigning() {
  if (process.env.SIGN_IDENTITY) return { identity: process.env.SIGN_IDENTITY, cleanup() {} };
  if (!process.env.CSC_LINK) return null;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crb-keychain-'));
  const keychain = path.join(dir, 'sign.keychain-db');
  const password = crypto.randomBytes(24).toString('hex');
  const link = process.env.CSC_LINK.trim();
  const p12 = path.join(dir, 'cert.p12');
  fs.writeFileSync(p12, fs.existsSync(link) ? fs.readFileSync(link) : Buffer.from(link, 'base64'));

  run('security', ['create-keychain', '-p', password, keychain]);
  run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
  run('security', ['unlock-keychain', '-p', password, keychain]);
  run('security', ['import', p12, '-k', keychain, '-P', process.env.CSC_KEY_PASSWORD || '', '-T', '/usr/bin/codesign']);
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain]);
  fs.rmSync(p12);

  // codesign can't resolve the identity from --keychain alone: the keychain must be on the user's
  // search list (electron-builder does the same). `security` has no "add", so read then re-set it.
  const previousList = run('security', ['list-keychains', '-d', 'user']).toString()
    .split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...previousList]);

  const listing = run('security', ['find-identity', '-v', '-p', 'codesigning', keychain]).toString();
  const match = listing.match(/([0-9A-F]{40}) "Developer ID Application:[^"]*"/);
  if (!match) throw new Error(`No "Developer ID Application" identity in CSC_LINK:\n${listing}`);
  return {
    identity: match[1],
    keychain,
    cleanup() {
      try { run('security', ['list-keychains', '-d', 'user', '-s', ...previousList]); } catch { /* best effort */ }
      try { run('security', ['delete-keychain', keychain]); } catch { /* already gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const signing = setupSigning();
if (!signing) {
  console.log('sign-vendor-natives: no SIGN_IDENTITY / CSC_LINK, skipping (jars left unsigned)');
  process.exit(0);
}
try {
  const jars = fs.readdirSync(vendorDir).filter((f) => f.endsWith('.jar')).sort();
  for (const jar of jars) processArchive(path.join(vendorDir, jar), signing, jar);
  console.log(`sign-vendor-natives: done (${jars.length} jars checked)`);
} finally {
  signing.cleanup();
}
