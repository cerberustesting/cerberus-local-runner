package org.cerberus.runner;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class ProcessSupervisor {
    enum State { STOPPED, STARTING, READY, STOPPING, ERROR }

    private static final Pattern QUICK_TUNNEL_URL = Pattern.compile("https://[a-zA-Z0-9-]+\\.trycloudflare\\.com");
    private static final int MAX_LOG_LINES = 500;

    private final RunnerConfig config;
    private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final Deque<String> logs = new ArrayDeque<>();
    private volatile State state = State.STOPPED;
    private volatile String tunnelUrl = "";
    private volatile String extensionTunnelUrl = "";
    private volatile String proxyTunnelUrl = "";
    private volatile String error = "";
    private Process selenium;
    private Process extension;
    private Process cloudflared;
    private Process cloudflaredExtension;
    private Process robotproxy;
    private Process cloudflaredProxy;

    ProcessSupervisor(RunnerConfig config) {
        this.config = config;
    }

    synchronized void startAsync() {
        if (state != State.STOPPED && state != State.ERROR) return;
        state = State.STARTING;
        error = "";
        tunnelUrl = "";
        extensionTunnelUrl = "";
        proxyTunnelUrl = "";
        CompletableFuture.runAsync(this::startInternal);
    }

    private void startInternal() {
        try {
            log("runner", "Starting Selenium");
            selenium = launch(seleniumCommand(), "selenium", null);
            waitForPort("127.0.0.1", config.integer("selenium.port"), "selenium", selenium);
            log("runner", "Selenium is ready at " + seleniumLocalUrl());

            log("runner", "Starting Cerberus Extension");
            extension = launch(extensionCommand(), "extension", null);
            waitForPort("127.0.0.1", config.integer("extension.port"), "extension", extension);
            log("runner", "Cerberus Extension is ready at " + extensionLocalUrl());

            log("runner", "Starting Cloudflare Tunnel");
            cloudflared = launch(cloudflaredCommand(seleniumLocalUrl()), "cloudflared", url -> tunnelUrl = url);
            tunnelUrl = waitForTunnel(cloudflared, "cloudflared.publicUrl", () -> tunnelUrl);

            if ("named".equalsIgnoreCase(config.get("cloudflared.mode"))) {
                extensionTunnelUrl = config.get("cloudflared.extensionPublicUrl");
                if (extensionTunnelUrl.isBlank()) throw new IOException("cloudflared.extensionPublicUrl is required in named mode");
            } else {
                log("runner", "Starting Cloudflare Tunnel for Extension");
                cloudflaredExtension = launch(cloudflaredCommand(extensionLocalUrl()), "cloudflared-extension", url -> extensionTunnelUrl = url);
                extensionTunnelUrl = waitForTunnel(cloudflaredExtension, null, () -> extensionTunnelUrl);
            }

            if (config.bool("robotproxy.enabled")) {
                log("runner", "Starting Cerberus Robot Proxy");
                robotproxy = launch(robotproxyCommand(), "robotproxy", null);
                waitForPort("127.0.0.1", config.integer("robotproxy.port"), "robotproxy", robotproxy);
                log("runner", "Robot Proxy is ready at " + robotproxyLocalUrl());

                if ("named".equalsIgnoreCase(config.get("cloudflared.mode"))) {
                    // A single named tunnel process already routes every configured hostname
                    // (per its own server-side ingress rules) - no second process to launch here.
                    proxyTunnelUrl = config.get("cloudflared.proxyPublicUrl");
                    if (proxyTunnelUrl.isBlank()) throw new IOException("cloudflared.proxyPublicUrl is required in named mode when robotproxy.enabled is true");
                } else {
                    log("runner", "Starting Cloudflare Tunnel for Robot Proxy");
                    cloudflaredProxy = launch(cloudflaredCommand(robotproxyLocalUrl()), "cloudflared-proxy", url -> proxyTunnelUrl = url);
                    proxyTunnelUrl = waitForTunnel(cloudflaredProxy, null, () -> proxyTunnelUrl);
                }
            }

            state = State.READY;
            log("runner", "Local runner is ready at " + tunnelUrl);
            sendCallback("READY");
        } catch (Exception exception) {
            error = exception.getMessage() == null ? exception.toString() : exception.getMessage();
            state = State.ERROR;
            log("runner", "Startup failed: " + error);
            stopProcesses();
        }
    }

    synchronized void stop() {
        if (state == State.STOPPED) return;
        state = State.STOPPING;
        sendCallback("STOPPING");
        stopProcesses();
        tunnelUrl = "";
        extensionTunnelUrl = "";
        proxyTunnelUrl = "";
        state = State.STOPPED;
        log("runner", "Stopped");
    }

    private void stopProcesses() {
        destroy(cloudflaredProxy, "cloudflared-proxy");
        destroy(robotproxy, "robotproxy");
        destroy(cloudflaredExtension, "cloudflared-extension");
        destroy(cloudflared, "cloudflared");
        destroy(extension, "extension");
        destroy(selenium, "selenium");
        cloudflaredProxy = null;
        robotproxy = null;
        cloudflaredExtension = null;
        cloudflared = null;
        extension = null;
        selenium = null;
    }

    private void destroy(Process process, String name) {
        if (process == null || !process.isAlive()) return;
        process.destroy();
        try {
            if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
        }
        log("runner", "Stopped " + name);
    }

    private List<String> seleniumCommand() throws IOException {
        if (config.bool("mock.mode")) return mockCommand("selenium", Integer.toString(config.integer("selenium.port")));

        Path seleniumJar = requireFile(config.component("selenium.jar"), "Selenium Server JAR");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        return List.of(
                java.toString(), "-jar", seleniumJar.toString(),
                "standalone", "--host", "127.0.0.1",
                "--port", Integer.toString(config.integer("selenium.port")),
                "--selenium-manager", "true"
        );
    }

    /** cerberus-robot-extension is its own standalone server (Main-Class QueueReceiver, listening on
     *  its own port) - Selenium's own "--ext" flag is unrelated (it loads pluggable SessionQueue/
     *  SessionMap/Distributor backends, e.g. Redis, not arbitrary jars), so this must run as its own
     *  process, exactly like the Docker image starts it via supervisord alongside the Selenium node. */
    private List<String> extensionCommand() throws IOException {
        if (config.bool("mock.mode")) return mockCommand("extension", Integer.toString(config.integer("extension.port")));

        Path extensionJar = requireFile(config.component("extension.jar"), "Cerberus extension JAR");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        return List.of(
                java.toString(), "-Djava.awt.headless=false", "-jar", extensionJar.toString(),
                "-p", Integer.toString(config.integer("extension.port"))
        );
    }

    private List<String> cloudflaredCommand(String targetUrl) throws IOException {
        if (config.bool("mock.mode")) return mockCommand("cloudflared", Integer.toString(URI.create(targetUrl).getPort()));

        Path binary = requireFile(config.component("cloudflared.binary"), "cloudflared binary");
        if (!Files.isExecutable(binary)) binary.toFile().setExecutable(true);
        if ("named".equalsIgnoreCase(config.get("cloudflared.mode"))) {
            if (config.get("cloudflared.token").isBlank()) throw new IOException("cloudflared.token is required in named mode");
            return List.of(binary.toString(), "tunnel", "--no-autoupdate", "run", "--token", config.get("cloudflared.token"));
        }
        return List.of(binary.toString(), "tunnel", "--no-autoupdate", "--url", targetUrl);
    }

    /** cerberus-robot-proxy spawns "mitmdump" as a bare sibling process (MyMITMProxyService),
     *  resolved through PATH - so unless mitmproxy.binary is left at its "mitmdump" default,
     *  we prepend the configured binary's own directory to the child's PATH. */
    private List<String> robotproxyCommand() throws IOException {
        if (config.bool("mock.mode")) return mockCommand("robotproxy", Integer.toString(config.integer("robotproxy.port")));

        Path jar = requireFile(config.component("robotproxy.jar"), "Cerberus Robot Proxy JAR");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        return List.of(java.toString(), "-jar", jar.toString(), "--server.port=" + config.integer("robotproxy.port"));
    }

    private List<String> mockCommand(String component, String port) {
        String classPath = System.getProperty("java.class.path");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        return List.of(java.toString(), "-cp", classPath, MockComponent.class.getName(), component, port);
    }

    private Path requireFile(Path path, String description) throws IOException {
        if (!Files.isRegularFile(path)) throw new IOException(description + " not found: " + path);
        return path;
    }

    private Process launch(List<String> command, String name, Consumer<String> onTunnelUrl) throws IOException {
        List<String> safeLogCommand = new ArrayList<>(command);
        int tokenIndex = safeLogCommand.indexOf("--token");
        if (tokenIndex >= 0 && tokenIndex + 1 < safeLogCommand.size()) safeLogCommand.set(tokenIndex + 1, "********");
        log("runner", "Launch: " + String.join(" ", safeLogCommand));
        ProcessBuilder builder = new ProcessBuilder(command).redirectErrorStream(true);
        if ("robotproxy".equals(name)) extendPathForMitmproxy(builder);
        Process process = builder.start();
        Thread logThread = new Thread(() -> readLogs(process, name, onTunnelUrl), "cerberus-" + name + "-logs");
        logThread.setDaemon(true);
        logThread.start();
        return process;
    }

    private void extendPathForMitmproxy(ProcessBuilder builder) {
        Path configured = config.component("mitmproxy.binary");
        if (!Files.isRegularFile(configured)) return; // a bare command name like "mitmdump": trust it is already on PATH.
        String existingPath = builder.environment().getOrDefault("PATH", "");
        builder.environment().put("PATH", configured.getParent() + java.io.File.pathSeparator + existingPath);
    }

    private void readLogs(Process process, String source, Consumer<String> onTunnelUrl) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                log(source, line);
                if (onTunnelUrl != null) {
                    Matcher matcher = QUICK_TUNNEL_URL.matcher(line);
                    if (matcher.find()) onTunnelUrl.accept(matcher.group());
                }
            }
        } catch (IOException exception) {
            log(source, "Log stream closed: " + exception.getMessage());
        }
    }

    private void waitForPort(String host, int port, String name, Process process) throws Exception {
        URI statusUri = URI.create("http://" + host + ":" + port + "/status");
        Instant deadline = Instant.now().plusSeconds(30);
        while (Instant.now().isBefore(deadline)) {
            if (process == null || !process.isAlive()) throw new IOException(name + " stopped during startup");
            boolean responded;
            try {
                HttpRequest request = HttpRequest.newBuilder(statusUri).timeout(Duration.ofSeconds(2)).GET().build();
                httpClient.send(request, HttpResponse.BodyHandlers.discarding());
                responded = true; // Any HTTP response (even a 404 on /status) proves *some* process holds the port.
            } catch (IOException ignored) {
                responded = false; // The local service is still starting.
            }
            if (responded) {
                // A pre-existing, unrelated process already bound to this port would answer just
                // as fast, right before our own process fails to bind the same port and exits -
                // give it a beat and confirm it's still ours before declaring victory.
                Thread.sleep(300);
                if (!process.isAlive()) {
                    throw new IOException(name + " exited right after port " + port + " answered - is another process already using it?");
                }
                return;
            }
            Thread.sleep(500);
        }
        throw new IOException(name + " did not become ready within 30 seconds");
    }

    /** publicUrlConfigKey is non-null only for the main tunnel, which supports the "named" mode
     *  reading a fixed public URL from config; the Robot Proxy's secondary tunnel is quick-mode only. */
    private String waitForTunnel(Process tunnelProcess, String publicUrlConfigKey, java.util.function.Supplier<String> urlGetter) throws Exception {
        if (publicUrlConfigKey != null && "named".equalsIgnoreCase(config.get("cloudflared.mode"))) {
            String url = config.get(publicUrlConfigKey);
            if (url.isBlank()) throw new IOException(publicUrlConfigKey + " is required in named mode");
            Thread.sleep(1500);
            if (tunnelProcess == null || !tunnelProcess.isAlive()) throw new IOException("cloudflared stopped during startup");
            return url;
        }
        Instant deadline = Instant.now().plusSeconds(30);
        while (Instant.now().isBefore(deadline)) {
            if (tunnelProcess == null || !tunnelProcess.isAlive()) throw new IOException("cloudflared stopped during startup");
            String url = urlGetter.get();
            if (url != null && !url.isBlank()) return url;
            Thread.sleep(250);
        }
        throw new IOException("Cloudflare Quick Tunnel URL was not received within 30 seconds");
    }

    private void sendCallback(String callbackState) {
        if (config.get("cerberus.callbackUrl").isBlank()) return;
        try {
            String payload = "{" +
                    "\"runnerId\":\"" + json(config.get("runner.id")) + "\"," +
                    "\"tunnelUrl\":\"" + json(tunnelUrl) + "\"," +
                    "\"seleniumUrl\":\"" + json(seleniumLocalUrl()) + "\"," +
                    "\"status\":\"" + json(callbackState) + "\"}";
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(config.get("cerberus.callbackUrl")))
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json");
            if (!config.get("cerberus.callbackBearerToken").isBlank()) {
                builder.header("Authorization", "Bearer " + config.get("cerberus.callbackBearerToken"));
            }
            httpClient.sendAsync(builder.POST(HttpRequest.BodyPublishers.ofString(payload)).build(), HttpResponse.BodyHandlers.discarding())
                    .thenAccept(response -> log("callback", "Cerberus callback returned HTTP " + response.statusCode()))
                    .exceptionally(exception -> { log("callback", "Callback failed: " + exception.getMessage()); return null; });
        } catch (Exception exception) {
            log("callback", "Callback failed: " + exception.getMessage());
        }
    }

    private String json(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    private String seleniumLocalUrl() {
        return "http://127.0.0.1:" + config.integer("selenium.port");
    }

    private String robotproxyLocalUrl() {
        return "http://127.0.0.1:" + config.integer("robotproxy.port");
    }

    private String extensionLocalUrl() {
        return "http://127.0.0.1:" + config.integer("extension.port");
    }

    private synchronized void log(String source, String message) {
        logs.addLast(Instant.now() + " [" + source + "] " + message);
        while (logs.size() > MAX_LOG_LINES) logs.removeFirst();
    }

    synchronized List<String> logs() {
        return List.copyOf(logs);
    }

    State state() { return state; }
    String tunnelUrl() { return tunnelUrl; }
    String proxyTunnelUrl() { return proxyTunnelUrl; }
    String extensionTunnelUrl() { return extensionTunnelUrl; }
    boolean robotproxyEnabled() { return config.bool("robotproxy.enabled"); }
    String error() { return error; }
    String runnerId() { return config.get("runner.id"); }
    String seleniumUrl() { return seleniumLocalUrl(); }
    String robotproxyUrl() { return robotproxyLocalUrl(); }
    String extensionUrl() { return extensionLocalUrl(); }
    Optional<Long> seleniumPid() { return selenium != null && selenium.isAlive() ? Optional.of(selenium.pid()) : Optional.empty(); }
    Optional<Long> cloudflaredPid() { return cloudflared != null && cloudflared.isAlive() ? Optional.of(cloudflared.pid()) : Optional.empty(); }
    Optional<Long> robotproxyPid() { return robotproxy != null && robotproxy.isAlive() ? Optional.of(robotproxy.pid()) : Optional.empty(); }
    Optional<Long> extensionPid() { return extension != null && extension.isAlive() ? Optional.of(extension.pid()) : Optional.empty(); }
    Optional<Long> cloudflaredExtensionPid() { return cloudflaredExtension != null && cloudflaredExtension.isAlive() ? Optional.of(cloudflaredExtension.pid()) : Optional.empty(); }
}
