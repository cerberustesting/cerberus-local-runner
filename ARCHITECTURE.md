# Architecture

Cerberus Local Runner is an Electron app. Its main process runs a small Node HTTP server on
`127.0.0.1:<ui.port>` (default `18080`) that supervises three-to-four local processes -
Selenium, the Cerberus Extension, cloudflared tunnels, and an optional Robot Proxy - and exposes
a JSON API consumed by a single-page UI (`src/resources/index.html`), which the app opens for
itself in a `BrowserWindow` instead of the system browser.

There used to be a Java implementation of the same design (jpackage-based). It has been fully
replaced by the Node/Electron code below; nothing in `src/` depends on Java anymore.

## Runtime flow

1. `run-dev.js` (dev) or the packaged app's own entry point loads `src/main.js`.
2. `main.js` builds `config` (`config.js`), `auth` (`auth.js`), `robots` (`robots.js`) and
   `supervisor` (`supervisor.js`), wires them into the HTTP server (`server.js`), starts that
   server, and opens a `BrowserWindow` pointed at it.
3. The UI (`index.html`) talks to that server exclusively via `fetch('/api/...')` - it has no
   Electron-specific code and doesn't know it's not talking to a plain browser tab.
4. Clicking Start calls `supervisor.startAsync()`, which spawns Selenium, the Extension, their
   cloudflared tunnels, and (if the selected robot template asks for one) the Robot Proxy and its
   tunnel - real binaries in production, `mock-component.js` stand-ins when `mock.mode=true`.

## File-by-file

### App code (`src/`)

| File | Role |
|---|---|
| `main.js` | Electron main process: wires everything together, opens the `BrowserWindow`, sets the app/Dock icon, routes `window.open()` (OAuth sign-in) to the system browser via `shell.openExternal`, stops everything cleanly on quit. |
| `config.js` | Reads/writes `config.properties` (a flat `key=value` file, format unchanged from the Java app) under the OS-appropriate app-data directory; supplies defaults; resolves bundled-binary paths relative to `vendor/` (dev) or the packaged app's resources dir. |
| `auth.js` | Cerberus authentication: API key mode, and OAuth Authorization Code + PKCE against Keycloak (token refresh, `/mcp` connection test). |
| `robots.js` | Thin pass-through to Cerberus's robot endpoints (list/get/create/delete) using whichever credentials `auth.js` holds. |
| `browsers.js` | Detects locally installed Chrome/Firefox/Edge/Safari (informational only, shown in the UI). |
| `supervisor.js` | The core: process state machine (STOPPED/STARTING/READY/STOPPING/ERROR), spawns/monitors Selenium, Extension, cloudflared tunnels and the Robot Proxy, independent per-service restart, log buffering. |
| `server.js` | The local HTTP API (`/api/status`, `/api/start`, `/api/auth/*`, `/api/robots/*`, etc.) and static file serving for `resources/`. Also computes `runnerPlatform` (this machine's real OS, forced onto cloned robots so Selenium never rejects a session over a platform mismatch). |
| `mock-component.js` | Stand-in process used instead of real Selenium/Extension/cloudflared when `mock.mode=true`, for fast local iteration without downloading real binaries. |
| `resources/index.html` | The entire UI: single HTML file, no build step, no framework. Talks only to `server.js`'s API. |
| `resources/cerberus-logo.png`, `resources/cerberus_logo_light.png` | Logos used inside the UI itself (header, OAuth panel) - not the app icon (see `build-resources/`). |

### Build & packaging

| File/dir | Role |
|---|---|
| `package.json` | App identity (`cerberus-local-runner`), npm scripts (`start`, `fetch-deps`, `pack:*` for unsigned local test builds, `release:*` for real installers), `electron-builder` config (icons, per-OS targets, `extraResources` mapping `vendor/` into the packaged app). |
| `run-dev.js` | Dev entry point: forces an isolated config directory (`.dev-config/`) and `mock.mode`, so `npm start` can never clobber a real install's saved credentials or fight it over the same port. Auto-detects `JAVA_HOME` (best-effort per OS; only the macOS path has actually been exercised) for `CRB_MOCK=false` real runs. |
| `scripts/fetch-dependencies.js` | Downloads the real Selenium/Extension/cloudflared/Robot Proxy/mitmdump binaries into `vendor/` (gitignored) per `dependencies.<os>.txt`. Same manifest format the old Java build used. |
| `dependencies.mac.txt`, `dependencies.linux.txt`, `dependencies.windows.txt` | `key=url` manifests read by `fetch-dependencies.js`. Not Java-specific despite the name/history - still the right place to update a binary's version/source. |
| `build-resources/icon.icns`, `icon.ico`, `icon.png` | The app icon actually used today (by `electron-builder` for packaging, and by `main.js` for the Dock/taskbar icon in dev) - a padded, rounded-card version of the logo, regenerated from `src/resources/cerberus_logo_light.png`. |
| `.github/workflows/release.yml` | CI: on a `v*` tag (or manual dispatch), builds all three OSes (`npm ci` → `fetch-deps` → `release:<os>`) and uploads the installers to a GitHub Release. |

### Local/generated state (gitignored, not part of the source tree)

| Path | What it is |
|---|---|
| `vendor/` | Real binaries fetched by `fetch-deps` (or copied manually during testing). Never committed. |
| `.dev-config/` | Throwaway config directory used by `npm start` (holds **your current real Cerberus session** - OAuth tokens, selected robot, etc. - don't delete this casually). |
| `node_modules/`, `dist/`, `build/`, `dependencies/` | npm packages, `electron-builder` output, and old Java build leftovers respectively. |
| `recordings/` | Empty directory Selenium creates on its own next to wherever it's launched from; harmless, safe to delete, will reappear. |

## Removed

The Java-specific build tooling this project used to have (`build-macos.sh`, `build-linux.sh`,
`build-windows.ps1`, `build-lib.sh`, `run-dev.sh`, `packaging/` icons, `config.example.properties`)
has been deleted - fully superseded by `scripts/fetch-dependencies.js` + `electron-builder` +
`.github/workflows/release.yml`, and validated end-to-end (real Selenium/Extension/cloudflared,
real OAuth, packaged builds for all three OSes).

## Worth knowing about but not code to delete

- **`.idea/`** - IntelliJ project files, already gitignored. `cerberus-local-runner.iml` still
  declares a `JAVA_MODULE` - stale, but purely local IDE state; harmless, and outside git either
  way. Safe to delete or reconfigure for a Node project if it bothers you.