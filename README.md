# Cerberus Local Runner

An Electron app that supervises, on your own machine:

1. Selenium Server in standalone mode;
2. the Cerberus Selenium extension;
3. a temporary Cloudflare Quick Tunnel targeting the local Selenium endpoint (and one for the
   extension);
4. optionally, the Cerberus Robot Proxy (and its own tunnel) when the selected robot template
   asks for one.

It displays state and logs at `http://127.0.0.1:18080` (opened for you in its own window - not
the system browser). See [ARCHITECTURE.md](ARCHITECTURE.md) for a file-by-file breakdown of how
it's built.

## Prerequisites

- Node.js 20+ and npm, to run/build the app itself. `npm run fetch-deps` bundles its own Temurin
  JRE 21 into `vendor/jre` (packaged app: the resources root) to launch the real (non-mock)
  Selenium/Extension/Robot Proxy jars - these are still plain Java processes, spawned like any
  other child process, but no system-installed JDK/JAVA_HOME is required;
- on macOS, `brew install mitmproxy` separately if you enable the Robot Proxy: mitmproxy.app is a
  code-signed Developer ID bundle that `electron-builder`'s re-signing pass would break the same
  way `jpackage`'s did, so it's never bundled there. The app's UI shows this reminder when the
  Robot Proxy is enabled on macOS.

## Run in development mode

```bash
npm install
npm start
```

This forces an isolated config directory (`.dev-config/`) and `mock.mode=true` - Selenium/
Extension/cloudflared are simulated, so nothing real gets downloaded or launched, and a real
install's saved credentials/robot/tunnels can never be touched. It also runs on port `18099`
instead of `18080`, so it can't fight a real running instance over the same port.

Other dev entry points:

```bash
# Real Selenium/Extension/cloudflared/Robot Proxy binaries (from vendor/, see below), still on
# the isolated port/config.
npm run start:real

# Real binaries, on port 18080 - required for OAuth sign-in, since Keycloak's
# "cerberus-local-runner" client only has http://127.0.0.1:18080/oauth/callback registered as a
# valid redirect_uri. Only safe to run when the real packaged app isn't also running.
npm run start:oauth
```

## Dependency manifest

`dependencies.<os>.txt` (repo root - one file per OS) declares every third-party binary the app
needs, one `<key>=<url>` line per dependency. `npm run fetch-deps` reads the manifest matching the
current OS and downloads each into `vendor/` (gitignored, never committed) under the filename
`config.js` expects. Only the `url` side ever needs updating when a dependency's version or
source changes - it can point anywhere reachable with a plain GET (this delivery server, an
artifact registry, a public release page). See the comments at the top of `dependencies.mac.txt`
for the full format.

`cerberusRobotProxy` and `mitmdump` are only fetched when `CERBERUS_ROBOT_PROXY=true` is set in
the environment (Robot Proxy feature). `mitmdump` is never fetched for macOS - see above.

```bash
npm run fetch-deps                        # Selenium, Extension, cloudflared only
CERBERUS_ROBOT_PROXY=true npm run fetch-deps   # + Robot Proxy (+ mitmdump outside macOS)
```

## Build the application

```bash
npm ci
npm run fetch-deps            # populate vendor/ first - electron-builder bundles whatever's in there

npm run release:mac           # -> dist/*.dmg
npm run release:linux         # -> dist/*.deb, dist/*.AppImage
npm run release:win           # -> dist/*.exe (NSIS installer)
```

Each of these must run on its target OS (no cross-signing). `pack:mac`/`pack:win`/`pack:linux`
are the same builds unpacked (`--dir`, no installer) for faster local iteration.

The app isn't code-signed yet on any platform (`mac.identity` is explicitly `null`). Until it is,
macOS Gatekeeper requires a right-click → **Open** on first launch, and Windows SmartScreen will
warn on the installer.

## Releasing

Pushing a tag matching `v*` (e.g. `v1.0.1`) triggers `.github/workflows/release.yml`, which builds
all three platforms (`npm ci` → `npm run fetch-deps` → `npm run release:<os>`, with
`CERBERUS_ROBOT_PROXY=true`) and uploads the installers to a GitHub Release named after the tag.

## Configuration

On first launch, the app creates a config file under the OS-appropriate app-data directory:

- macOS: `~/Library/Application Support/Cerberus Local Runner/config.properties`
- Windows: `%APPDATA%\Cerberus Local Runner\config.properties`
- Linux: `$XDG_CONFIG_HOME/cerberus-local-runner/config.properties` (or `~/.config/...`)

`config.js`'s `defaults()` is the source of truth for every key and its default value; the
notable ones:

```properties
ui.port=18080
selenium.port=4444
extension.port=6555
cloudflared.mode=quick
robotproxy.enabled=false
robotproxy.port=8093
mitmproxy.binary=mitmdump
cerberus.callbackUrl=
cerberus.callbackBearerToken=
runner.id=
autostart=false
mock.mode=false
```

Relative component paths (`selenium.jar`, `cloudflared.binary`, etc.) are resolved from `vendor/`
in dev, or the packaged app's own resources directory in production. `runner.id` is generated
automatically if empty. `robotproxy.enabled` is toggled automatically by the UI when you pick a
robot template whose executor asks for a proxy - not meant to be set by hand.

When `cerberus.callbackUrl` is configured, the runner POSTs this JSON once the tunnel becomes
ready:

```json
{
  "runnerId": "local-runner-uuid",
  "tunnelUrl": "https://random.trycloudflare.com",
  "seleniumUrl": "http://127.0.0.1:4444",
  "status": "READY"
}
```

The callback can be protected with `cerberus.callbackBearerToken`.

## Named tunnel mode

Quick Tunnels return a temporary random URL each time. A managed, fixed-hostname tunnel can be
selected instead with:

```properties
cloudflared.mode=named
cloudflared.token=the-managed-tunnel-token
cloudflared.publicUrl=https://runner.example.com
cloudflared.extensionPublicUrl=https://runner-extension.example.com
cloudflared.proxyPublicUrl=https://runner-proxy.example.com
```

The Cloudflare route(s) must already map each public hostname to the corresponding local port
(Selenium, Extension, Robot Proxy). In this mode, a single shared `cloudflared` process serves
every hostname server-side, so independently restarting one service only restarts its local
process, never the tunnel.

## Authentication

Two modes, picked in the UI: a per-user API key (`X-API-KEY`), or OAuth Authorization Code + PKCE
against Cerberus's Keycloak. Both are only ever verified against `/mcp`. OAuth sign-in opens in
your system browser (so it can reuse an existing Cerberus session there), not in the app's own
window; the callback is still handled locally at `/oauth/callback`.

## Important security limitation

This exposes the Selenium (and, if enabled, Robot Proxy) endpoint through a public tunnel. Use it
only with an authenticated Cloudflare route or a server-controlled, short-lived tunnel.