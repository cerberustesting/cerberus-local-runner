# Cerberus Local Runner — macOS prototype

This prototype packages a small Java supervisor as a native macOS application. It starts:

1. Selenium Server in standalone mode;
2. the Cerberus Selenium extension through `--ext`;
3. a temporary Cloudflare Quick Tunnel targeting the local Selenium endpoint.

It then displays the state and logs at `http://127.0.0.1:18080`. Docker and a system-wide Java installation are not required by the packaged application.

## Prerequisites for building

- macOS with JDK 17 or newer (`java`, `javac`, `jar`, and `jpackage`);
- a Selenium Server standalone JAR;
- the Cerberus Selenium extension JAR;
- a `cloudflared` macOS binary matching the Mac architecture.

The application package must be built on macOS. Build once on Apple Silicon and once on Intel if both architectures are required.

## Build the application

```bash
chmod +x build-macos.sh
./build-macos.sh \
  /path/to/selenium-server-4.44.0.jar \
  /path/to/cerberus-extension.jar \
  /path/to/cloudflared
```

Outputs:

- `dist/Cerberus Local Runner.app`
- `dist/Cerberus Local Runner-0.1.0.dmg`

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

