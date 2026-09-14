package org.cerberus.runner;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Collectors;

final class LocalHttpServer {
    private final HttpServer server;
    private final RunnerConfig config;
    private final ProcessSupervisor supervisor;
    private final CerberusAuthService auth;
    private final CerberusRobotService robots;

    LocalHttpServer(RunnerConfig config, ProcessSupervisor supervisor, CerberusAuthService auth, CerberusRobotService robots) throws IOException {
        this.config = config;
        this.supervisor = supervisor;
        this.auth = auth;
        this.robots = robots;
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", config.integer("ui.port")), 0);
        server.createContext("/", this::index);
        server.createContext("/api/status", this::status);
        server.createContext("/api/logs", this::logs);
        server.createContext("/api/start", exchange -> action(exchange, supervisor::startAsync));
        server.createContext("/api/stop", exchange -> action(exchange, supervisor::stop));
        server.createContext("/api/auth/status", this::authStatus);
        server.createContext("/api/auth/apikey", this::authApiKey);
        server.createContext("/api/auth/oauth/start", this::authOAuthStart);
        server.createContext("/api/auth/test", this::authTest);
        server.createContext("/api/auth/logout", this::authLogout);
        server.createContext("/oauth/callback", this::oauthCallback);
        server.createContext("/api/robots", this::robotsEndpoint);
        server.createContext("/api/robotproxy/enable", this::robotproxyEnable);
        server.createContext("/cerberus-logo.png", exchange -> image(exchange, "/cerberus-logo.png"));
        server.createContext("/cerberus_logo_light.png", exchange -> image(exchange, "/cerberus_logo_light.png"));
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
    }

    void start() { server.start(); }
    void stop() { server.stop(0); }

    private void index(HttpExchange exchange) throws IOException {
        if (!"/".equals(exchange.getRequestURI().getPath())) {
            send(exchange, 404, "text/plain; charset=utf-8", "Not found");
            return;
        }
        try (InputStream input = LocalHttpServer.class.getResourceAsStream("/index.html")) {
            if (input == null) throw new IOException("index.html is missing");
            send(exchange, 200, "text/html; charset=utf-8", new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private void image(HttpExchange exchange, String resourceName) throws IOException {
        try (InputStream input = LocalHttpServer.class.getResourceAsStream(resourceName)) {
            if (input == null) { send(exchange, 404, "text/plain; charset=utf-8", "Not found"); return; }
            byte[] bytes = input.readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", "image/png");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        }
    }

    private void robotproxyEnable(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            send(exchange, 405, "application/json", "{\"error\":\"POST required\"}");
            return;
        }
        String body = readBody(exchange);
        boolean enabled = "true".equalsIgnoreCase(CerberusAuthService.jsonField(body, "enabled"));
        config.set("robotproxy.enabled", Boolean.toString(enabled));
        config.save();
        send(exchange, 200, "application/json", "{\"ok\":true}");
    }

    private void status(HttpExchange exchange) throws IOException {
        String body = "{" +
                "\"state\":\"" + supervisor.state() + "\"," +
                "\"runnerId\":\"" + json(supervisor.runnerId()) + "\"," +
                "\"seleniumUrl\":\"" + json(supervisor.seleniumUrl()) + "\"," +
                "\"tunnelUrl\":\"" + json(supervisor.tunnelUrl()) + "\"," +
                "\"seleniumPid\":" + supervisor.seleniumPid().map(String::valueOf).orElse("null") + "," +
                "\"cloudflaredPid\":" + supervisor.cloudflaredPid().map(String::valueOf).orElse("null") + "," +
                "\"extensionUrl\":\"" + json(supervisor.extensionUrl()) + "\"," +
                "\"extensionPid\":" + supervisor.extensionPid().map(String::valueOf).orElse("null") + "," +
                "\"extensionTunnelUrl\":\"" + json(supervisor.extensionTunnelUrl()) + "\"," +
                "\"cloudflaredExtensionPid\":" + supervisor.cloudflaredExtensionPid().map(String::valueOf).orElse("null") + "," +
                "\"error\":\"" + json(supervisor.error()) + "\"," +
                "\"robotName\":\"" + json(robots.selectedRobot()) + "\"," +
                "\"robotproxyEnabled\":" + supervisor.robotproxyEnabled() + "," +
                "\"robotproxyUrl\":\"" + json(supervisor.robotproxyUrl()) + "\"," +
                "\"proxyTunnelUrl\":\"" + json(supervisor.proxyTunnelUrl()) + "\"," +
                "\"robotproxyPid\":" + supervisor.robotproxyPid().map(String::valueOf).orElse("null") + "}";
        send(exchange, 200, "application/json; charset=utf-8", body);
    }

    private void logs(HttpExchange exchange) throws IOException {
        String body = supervisor.logs().stream().map(line -> "\"" + json(line) + "\"").collect(Collectors.joining(",", "[", "]"));
        send(exchange, 200, "application/json; charset=utf-8", body);
    }

    private void action(HttpExchange exchange, Runnable action) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            send(exchange, 405, "application/json", "{\"error\":\"POST required\"}");
            return;
        }
        action.run();
        send(exchange, 202, "application/json", "{\"accepted\":true}");
    }

    private void authStatus(HttpExchange exchange) throws IOException {
        Map<String, Object> status = auth.status();
        String body = "{" +
                "\"cerberusUrl\":\"" + json(str(status.get("cerberusUrl"))) + "\"," +
                "\"mode\":\"" + json(str(status.get("mode"))) + "\"," +
                "\"authenticated\":" + status.get("authenticated") + "," +
                "\"login\":\"" + json(str(status.get("login"))) + "\"," +
                "\"runnerName\":\"" + json(robots.runnerName()) + "\"," +
                "\"keycloakUrl\":\"" + json(str(status.get("keycloakUrl"))) + "\"," +
                "\"realm\":\"" + json(str(status.get("realm"))) + "\"," +
                "\"clientId\":\"" + json(str(status.get("clientId"))) + "\"," +
                "\"redirectUri\":\"" + json(str(status.get("redirectUri"))) + "\"}";
        send(exchange, 200, "application/json; charset=utf-8", body);
    }

    private void authApiKey(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            send(exchange, 405, "application/json", "{\"error\":\"POST required\"}");
            return;
        }
        String body = readBody(exchange);
        String cerberusUrl = CerberusAuthService.jsonField(body, "cerberusUrl");
        String apiKey = CerberusAuthService.jsonField(body, "apiKey");
        try {
            send(exchange, 200, "application/json; charset=utf-8", resultJson(auth.saveApiKey(cerberusUrl, apiKey)));
        } catch (IOException exception) {
            send(exchange, 400, "application/json; charset=utf-8", resultJson(new CerberusAuthService.TestResult("failed", exception.getMessage())));
        }
    }

    private void authOAuthStart(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            send(exchange, 405, "application/json", "{\"error\":\"POST required\"}");
            return;
        }
        String body = readBody(exchange);
        String cerberusUrl = CerberusAuthService.jsonField(body, "cerberusUrl");
        try {
            String authorizeUrl = auth.startOAuth(cerberusUrl);
            send(exchange, 200, "application/json; charset=utf-8", "{\"authorizeUrl\":\"" + json(authorizeUrl) + "\"}");
        } catch (IOException exception) {
            send(exchange, 400, "application/json; charset=utf-8", "{\"error\":\"" + json(exception.getMessage()) + "\"}");
        }
    }

    private void authTest(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            send(exchange, 405, "application/json", "{\"error\":\"POST required\"}");
            return;
        }
        send(exchange, 200, "application/json; charset=utf-8", resultJson(auth.testConnection()));
    }

    private void authLogout(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            send(exchange, 405, "application/json", "{\"error\":\"POST required\"}");
            return;
        }
        auth.logout();
        send(exchange, 200, "application/json", "{\"ok\":true}");
    }

    private void oauthCallback(HttpExchange exchange) throws IOException {
        Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());
        String html;
        try {
            String login = auth.completeOAuth(query.get("code"), query.get("state"), query.get("error"), query.get("error_description"));
            html = callbackPage(true, "Signed in" + (login == null || login.isBlank() ? "" : " as " + escapeHtml(login))
                    + ". This tab will close automatically - if it doesn't, you can close it and return to the Cerberus Local Runner.");
        } catch (Exception exception) {
            html = callbackPage(false, escapeHtml(exception.getMessage()));
        }
        send(exchange, 200, "text/html; charset=utf-8", html);
    }

    private void robotsEndpoint(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        String remainder = path.length() > "/api/robots".length() ? path.substring("/api/robots".length()) : "";
        if (remainder.startsWith("/")) remainder = remainder.substring(1);

        try {
            if ("POST".equalsIgnoreCase(exchange.getRequestMethod()) && "select".equals(remainder)) {
                String body = readBody(exchange);
                robots.select(CerberusAuthService.jsonField(body, "robot"));
                send(exchange, 200, "application/json", "{\"ok\":true}");
            } else if ("POST".equalsIgnoreCase(exchange.getRequestMethod()) && "runnerName".equals(remainder)) {
                String body = readBody(exchange);
                robots.setRunnerName(CerberusAuthService.jsonField(body, "runnerName"));
                send(exchange, 200, "application/json", "{\"ok\":true}");
            } else if ("POST".equalsIgnoreCase(exchange.getRequestMethod()) && remainder.isBlank()) {
                // Forwarded byte-for-byte: the browser (real JSON) builds the robot+capabilities+executor payload.
                CerberusRobotService.RobotResult result = robots.createRobot(readBody(exchange));
                send(exchange, result.status(), "application/json; charset=utf-8", result.body());
            } else if ("DELETE".equalsIgnoreCase(exchange.getRequestMethod()) && !remainder.isBlank()) {
                CerberusRobotService.RobotResult result = robots.deleteRobot(remainder);
                send(exchange, result.status(), "application/json; charset=utf-8", result.body());
            } else if ("GET".equalsIgnoreCase(exchange.getRequestMethod()) && remainder.isBlank()) {
                CerberusRobotService.RobotResult result = robots.listRobots();
                send(exchange, result.status(), "application/json; charset=utf-8", result.body());
            } else if ("GET".equalsIgnoreCase(exchange.getRequestMethod()) && !remainder.isBlank()) {
                CerberusRobotService.RobotResult result = robots.getRobot(remainder);
                send(exchange, result.status(), "application/json; charset=utf-8", result.body());
            } else {
                send(exchange, 404, "application/json", "{\"error\":\"not found\"}");
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            send(exchange, 502, "application/json", "{\"error\":\"interrupted\"}");
        } catch (Exception exception) {
            String message = exception.getMessage() == null ? exception.toString() : exception.getMessage();
            send(exchange, 502, "application/json; charset=utf-8", "{\"error\":\"" + json(message) + "\"}");
        }
    }

    private Map<String, String> parseQuery(String rawQuery) {
        Map<String, String> result = new HashMap<>();
        if (rawQuery == null || rawQuery.isBlank()) return result;
        for (String pair : rawQuery.split("&")) {
            int index = pair.indexOf('=');
            if (index < 0) continue;
            result.put(URLDecoder.decode(pair.substring(0, index), StandardCharsets.UTF_8),
                    URLDecoder.decode(pair.substring(index + 1), StandardCharsets.UTF_8));
        }
        return result;
    }

    private String resultJson(CerberusAuthService.TestResult result) {
        return "{\"status\":\"" + json(result.status()) + "\",\"message\":\"" + json(result.message()) + "\"}";
    }

    private String callbackPage(boolean success, String message) {
        String color = success ? "#10b981" : "#e63757";
        // window.close() is a no-op in most browsers on a tab that wasn't opened via window.open(),
        // so this is a best-effort convenience, not something the flow depends on.
        String autoClose = success ? "<script>setTimeout(function(){window.close();},1200);</script>" : "";
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Cerberus Local Runner</title>"
                + "<style>body{font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;"
                + "display:flex;align-items:center;justify-content:center;height:100vh;margin:0}"
                + ".box{max-width:420px;padding:28px;border-radius:16px;background:#1e293b;border:1px solid #334155;text-align:center}"
                + "h1{font-size:18px;margin:0 0 8px;color:" + color + "}p{color:#94a3b8;font-size:14px}</style></head>"
                + "<body><div class=\"box\"><h1>" + (success ? "Connected" : "Sign-in failed") + "</h1><p>" + message + "</p></div></body>" + autoClose + "</html>";
    }

    private String escapeHtml(String value) {
        return value == null ? "" : value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private String readBody(HttpExchange exchange) throws IOException {
        try (InputStream input = exchange.getRequestBody()) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private String str(Object value) {
        return value == null ? "" : value.toString();
    }

    private void send(HttpExchange exchange, int status, String contentType, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private String json(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }
}

