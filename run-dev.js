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

// javaBinary() in supervisor.js needs this to launch the real selenium-server.jar/
// cerberus-extension.jar/cerberus-robot-proxy.jar - cerberus-extension.jar is built for Java 21
// (class file version 65), so that's required, not just "a JDK". Best-effort per-OS auto-detect;
// only the macOS path has actually been exercised - if this misses on Windows/Linux, set
// JAVA_HOME yourself and it's used as-is (checked first, above). javaBinary() still throws a
// clear error if none of this finds anything.
if (!process.env.JAVA_HOME) {
  const detected = detectJavaHome();
  if (detected) process.env.JAVA_HOME = detected;
}

function detectJavaHome() {
  const hasJavaBinary = dir => fs.existsSync(path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));

  if (process.platform === 'darwin') {
    const { execFileSync } = require('child_process');
    // `java_home -v 21` doesn't fail when no JDK 21 is registered - it silently falls back to
    // whatever other JVM it knows about (e.g. 17), so its result must be checked, not trusted.
    // It also won't see Homebrew's openjdk@21 unless it's symlinked into
    // /Library/Java/JavaVirtualMachines (a Homebrew caveat, not something `brew install` does for
    // you) - fall back to its Cellar path directly, both Apple Silicon and Intel prefixes.
    try {
      const found = execFileSync('/usr/libexec/java_home', ['-v', '21']).toString().trim();
      if (found.includes('21')) return found;
    } catch {
      // fall through to the Homebrew-path candidates below
    }
    for (const candidate of ['/opt/homebrew/opt/openjdk@21', '/usr/local/opt/openjdk@21']) {
      if (hasJavaBinary(candidate)) return candidate;
    }
    return undefined;
  }

  if (process.platform === 'win32') {
    // Common install roots for Temurin/Microsoft/Oracle JDK 21 builds.
    for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
      if (!base || !fs.existsSync(base)) continue;
      for (const vendorDir of ['Eclipse Adoptium', 'Microsoft', 'Java']) {
        const vendorPath = path.join(base, vendorDir);
        if (!fs.existsSync(vendorPath)) continue;
        const match = fs.readdirSync(vendorPath).find(name => /21/.test(name) && hasJavaBinary(path.join(vendorPath, name)));
        if (match) return path.join(vendorPath, match);
      }
    }
    return undefined;
  }

  // Linux: Debian/Ubuntu/RHEL packages and Adoptium/SDKMAN installs commonly land under /usr/lib/jvm.
  const jvmRoot = '/usr/lib/jvm';
  if (fs.existsSync(jvmRoot)) {
    const match = fs.readdirSync(jvmRoot).find(name => /21/.test(name) && hasJavaBinary(path.join(jvmRoot, name)));
    if (match) return path.join(jvmRoot, match);
  }
  return undefined;
}

require('./src/main.js');