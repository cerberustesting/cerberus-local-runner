# Cerberus Local Runner

This prototype packages a small Java supervisor as a native application (macOS, Linux, Windows). It starts:

1. Selenium Server in standalone mode;
2. the Cerberus Selenium extension through `--ext`;
3. a temporary Cloudflare Quick Tunnel targeting the local Selenium endpoint.

It then displays the state and logs at `http://127.0.0.1:18080`. Docker and a system-wide Java installation are not required by the packaged application.

## Prerequisites for building

- JDK 21 or newer on `PATH` (`java`, `javac`, `jar`, `jlink`, and `jpackage`), plus `curl` (macOS/Linux) or PowerShell with internet access (Windows);
- network access to whatever URLs `dependencies.txt` points at;
- on Windows, the WiX Toolset v3 on `PATH` for the `.exe` installer.

Each build script must run on its target OS - `jpackage` does not cross-compile. Build once per OS (and once per Mac architecture if both Apple Silicon and Intel are required).

## Dependency manifest

`dependencies.<os>.txt` (repo root - one file per OS: `dependencies.mac.txt`, `dependencies.linux.txt`, `dependencies.windows.txt`) declares every third-party binary that OS's build script fetches, one `<key>=<url>` line per dependency. Each build script only reads its own manifest and looks up the keys it needs (e.g. `seleniumServer`, `cloudflared`), saving the download under its own fixed destination filename - the one the app expects. Only the `url` side ever needs updating when a dependency's version or source changes, and it can point anywhere reachable with `curl`/`Invoke-WebRequest` (this delivery server, an artifact registry, or a public release page), whatever filename the source actually uses. See the comments at the top of `dependencies.mac.txt` for the full format.

`cerberusRobotProxy`, `mitmdumpLinux` and `mitmdumpWindows` are only downloaded when `CERBERUS_ROBOT_PROXY=true` (Robot Proxy feature). On macOS, `mitmdump` is deliberately **not** bundled even then: `jpackage`'s ad-hoc re-signing pass breaks mitmproxy.app's own already-signed binaries (and re-signing it ourselves still gets it killed by the hardened runtime at launch). Run `brew install mitmproxy` on the Mac before enabling the Robot Proxy - the app's UI shows this reminder when the Robot Proxy is enabled on macOS.

## Build the application

```bash
# macOS
chmod +x build-macos.sh
./build-macos.sh

# Linux
chmod +x build-linux.sh
./build-linux.sh

# Windows (PowerShell)
./build-windows.ps1
```

Outputs:

- macOS: `dist/Cerberus Local Runner.app` and `dist/Cerberus Local Runner-1.0.1.dmg`
- Linux: `dist/Cerberus Local Runner/` (app-image) and a `.deb` package
- Windows: `dist/Cerberus Local Runner/` (app-image) and a `.exe` installer

For an initial unsigned build, macOS Gatekeeper may require a right-click followed by **Open**. For wider distribution, sign and notarize the application. The build script supports `CERBERUS_MAC_SIGN_IDENTITY` when a Developer ID Application certificate is available.

## Run in development mode

The following command compiles and launches the application with simulated Selenium and Cloudflare processes:

```bash
chmod +x run-dev.sh
./run-dev.sh
```

Open `http://127.0.0.1:18080`, then use **Start local runner** and **Stop**.

## Configuration

On first launch, the application creates:

```text
~/Library/Application Support/Cerberus Local Runner/config.properties
```

Relevant properties:

```properties
ui.port=18080
selenium.port=4444
selenium.jar=selenium-server.jar
extension.jar=cerberus-extension.jar
cloudflared.binary=cloudflared
cloudflared.mode=quick
cerberus.callbackUrl=
cerberus.callbackBearerToken=
runner.id=
autostart=false
openBrowser=true
```

Relative component paths are resolved from the application directory. `runner.id` is generated automatically if empty.

When `cerberus.callbackUrl` is configured, the runner sends this JSON after the tunnel becomes ready:

```json
{
  "runnerId": "local-runner-uuid",
  "tunnelUrl": "https://random.trycloudflare.com",
  "seleniumUrl": "http://127.0.0.1:4444",
  "status": "READY"
}
```

The callback can be protected with `cerberus.callbackBearerToken`. For the production version, replace the static token with a short-lived token obtained through the authenticated Cerberus pairing flow.

## Named tunnel mode

Quick Tunnels are useful for the prototype because they return a temporary random URL. A managed tunnel can be selected with:

```properties
cloudflared.mode=named
cloudflared.token=the-short-lived-or-managed-token
cloudflared.publicUrl=https://runner.example.com
```

The Cloudflare route must already map the public hostname to `http://127.0.0.1:4444`.

## Important security limitation

This first prototype exposes the Selenium endpoint through the tunnel. It must only be used with an authenticated Cloudflare route or a server-controlled, short-lived tunnel. The target architecture should move execution into the Local Runner and keep only an outbound WebSocket connection to Cerberus.

