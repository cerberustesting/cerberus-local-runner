package org.cerberus.runner;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import java.util.UUID;

final class RunnerConfig {
    private final Properties properties;
    private final Path configFile;
    private final Path applicationDirectory;

    private RunnerConfig(Properties properties, Path configFile, Path applicationDirectory) {
        this.properties = properties;
        this.configFile = configFile;
        this.applicationDirectory = applicationDirectory;
    }

    static RunnerConfig load() throws IOException {
        Path appDirectory = detectApplicationDirectory();
        Path configDirectory = detectConfigDirectory();
        Files.createDirectories(configDirectory);
        Path configFile = configDirectory.resolve("config.properties");

        Properties properties = defaults();
        if (Files.exists(configFile)) {
            try (InputStream input = Files.newInputStream(configFile)) {
                properties.load(input);
            }
        }
        if (properties.getProperty("runner.id", "").isBlank()) {
            properties.setProperty("runner.id", "local-" + UUID.randomUUID());
        }
        try (OutputStream output = Files.newOutputStream(configFile)) {
            properties.store(output, "Cerberus Local Runner");
        }
        return new RunnerConfig(properties, configFile, appDirectory);
    }

    private static Properties defaults() {
        Properties result = new Properties();
        result.setProperty("ui.port", "18080");
        result.setProperty("selenium.port", "4444");
        result.setProperty("selenium.jar", "selenium-server.jar");
        result.setProperty("extension.jar", "cerberus-extension.jar");
        result.setProperty("extension.port", "6555");
        result.setProperty("cloudflared.binary", isWindows() ? "cloudflared.exe" : "cloudflared");
        result.setProperty("cloudflared.mode", "quick");
        result.setProperty("cloudflared.token", "");
        result.setProperty("cloudflared.publicUrl", "");
        result.setProperty("cloudflared.proxyPublicUrl", "");
        result.setProperty("cloudflared.extensionPublicUrl", "");
        result.setProperty("robotproxy.enabled", "false");
        result.setProperty("robotproxy.jar", "cerberus-robot-proxy.jar");
        result.setProperty("robotproxy.port", "8093");
        // Not bundled by build-macos.sh: mitmproxy.app is a code-signed Developer ID bundle whose
        // Python runtime only works untouched, and jpackage's own ad-hoc re-signing pass breaks it
        // (fails outright on the "already signed" nested files, and even re-signing it ourselves
        // first still gets the binary killed by the kernel at launch). Leave this as "mitmdump" to
        // resolve it via PATH (e.g. "brew install mitmproxy"), or set an absolute path to your own
        // untouched mitmproxy.app's mitmdump if you'd rather not rely on PATH.
        // build-linux.sh and build-windows.ps1 don't have this signing constraint, so they bundle
        // mitmdump right next to selenium-server.jar - hence the platform-specific filename here.
        result.setProperty("mitmproxy.binary", isWindows() ? "mitmdump.exe" : "mitmdump");
        result.setProperty("cerberus.callbackUrl", "");
        result.setProperty("cerberus.callbackBearerToken", "");
        result.setProperty("runner.id", "");
        result.setProperty("autostart", "false");
        result.setProperty("openBrowser", "true");
        result.setProperty("mock.mode", "false");

        result.setProperty("cerberus.url", "");
        result.setProperty("cerberus.auth.mode", "");
        result.setProperty("cerberus.auth.apiKey", "");
        result.setProperty("cerberus.auth.verified", "");
        result.setProperty("cerberus.auth.login", "");
        result.setProperty("cerberus.auth.oauth.keycloakUrl", "");
        result.setProperty("cerberus.auth.oauth.realm", "");
        result.setProperty("cerberus.auth.oauth.clientId", "cerberus-local-runner");
        result.setProperty("cerberus.auth.oauth.accessToken", "");
        result.setProperty("cerberus.auth.oauth.refreshToken", "");
        result.setProperty("cerberus.auth.oauth.expiresAt", "0");
        result.setProperty("robot.name", "");
        result.setProperty("robot.runnerName", "");
        return result;
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }

    private static Path detectConfigDirectory() {
        // Lets run-dev.sh point at a throwaway config directory instead of the real app's, so
        // dev runs (which force mock.mode=true) never clobber the packaged app's own settings.
        String override = System.getenv("CRB_CONFIG_DIR");
        if (override != null && !override.isBlank()) return Path.of(override);

        Path home = Path.of(System.getProperty("user.home"));
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("win")) {
            String appData = System.getenv("APPDATA");
            Path base = appData == null || appData.isBlank() ? home.resolve("AppData").resolve("Roaming") : Path.of(appData);
            return base.resolve("Cerberus Local Runner");
        }
        if (os.contains("mac") || os.contains("darwin")) {
            return home.resolve("Library").resolve("Application Support").resolve("Cerberus Local Runner");
        }
        String xdgConfigHome = System.getenv("XDG_CONFIG_HOME");
        Path base = xdgConfigHome == null || xdgConfigHome.isBlank() ? home.resolve(".config") : Path.of(xdgConfigHome);
        return base.resolve("cerberus-local-runner");
    }

    private static Path detectApplicationDirectory() {
        try {
            return Path.of(RunnerConfig.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getParent();
        } catch (Exception ignored) {
            return Path.of(".").toAbsolutePath().normalize();
        }
    }

    Path component(String key) {
        Path configured = Path.of(get(key));
        return configured.isAbsolute() ? configured : applicationDirectory.resolve(configured).normalize();
    }

    String get(String key) {
        return properties.getProperty(key, "").trim();
    }

    int integer(String key) {
        return Integer.parseInt(get(key));
    }

    boolean bool(String key) {
        return Boolean.parseBoolean(get(key));
    }

    Path configFile() {
        return configFile;
    }

    synchronized void set(String key, String value) {
        properties.setProperty(key, value == null ? "" : value);
    }

    synchronized void save() throws IOException {
        try (OutputStream output = Files.newOutputStream(configFile)) {
            properties.store(output, "Cerberus Local Runner");
        }
    }

    int port() {
        return integer("ui.port");
    }
}

