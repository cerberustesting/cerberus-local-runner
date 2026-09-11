package org.cerberus.runner;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Looks up Cerberus "robots" (GET /api/public/robots, GET /api/public/robots/{robot}) and lets the
 * browser (real JSON, unlike this class) delete/recreate a per-user "local-runner-{login}" robot -
 * cloning the config/capabilities of whichever robot the user picked as a template and pointing a
 * freshly created executor at this runner's tunnels - using whichever credentials
 * {@link CerberusAuthService} already holds. Everything here is a thin, un-parsed pass-through:
 * cerberus-core's real payloads are built/read by the frontend, which has an actual JSON parser.
 */
final class CerberusRobotService {

    /** Raw pass-through of Cerberus's JSON response: the caller (the browser) parses it, we don't need to. */
    record RobotResult(int status, String body) {
    }

    private final RunnerConfig config;
    private final CerberusAuthService auth;
    private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();

    CerberusRobotService(RunnerConfig config, CerberusAuthService auth) {
        this.config = config;
        this.auth = auth;
    }

    /** The template robot the user picked in the UI to clone from. */
    String selectedRobot() {
        return config.get("robot.name");
    }

    synchronized void select(String robotName) throws IOException {
        config.set("robot.name", robotName == null ? "" : robotName.trim());
        config.save();
    }

    RobotResult listRobots() throws IOException, InterruptedException {
        return get("/api/public/robots");
    }

    RobotResult getRobot(String robotName) throws IOException, InterruptedException {
        return get("/api/public/robots/" + urlEncodeSegment(robotName));
    }

    /** DELETE /api/public/robots/{robot} - deletes a robot (cascading capabilities/executors). */
    RobotResult deleteRobot(String robotName) throws IOException, InterruptedException {
        CerberusAuthService.AuthHeader authHeader = auth.authHeader();
        String cerberusUrl = auth.cerberusUrl();
        if (cerberusUrl.isBlank()) return new RobotResult(400, "{\"error\":\"Set a Cerberus URL first\"}");
        if (authHeader == null) return new RobotResult(401, "{\"error\":\"Not authenticated\"}");

        HttpRequest request = HttpRequest.newBuilder(URI.create(cerberusUrl + "/api/public/robots/" + urlEncodeSegment(robotName)))
                .timeout(Duration.ofSeconds(10))
                .header("Accept", "application/json")
                .header("X-API-VERSION", "1")
                .header(authHeader.name(), authHeader.value())
                .DELETE().build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        return new RobotResult(response.statusCode(), response.body());
    }

    /** POST /api/public/robots - creates a robot, its capabilities and its executors in one call.
     *  rawBody is forwarded exactly as built by the browser (real JSON there, unlike here). */
    RobotResult createRobot(String rawBody) throws IOException, InterruptedException {
        CerberusAuthService.AuthHeader authHeader = auth.authHeader();
        String cerberusUrl = auth.cerberusUrl();
        if (cerberusUrl.isBlank()) return new RobotResult(400, "{\"error\":\"Set a Cerberus URL first\"}");
        if (authHeader == null) return new RobotResult(401, "{\"error\":\"Not authenticated\"}");

        HttpRequest request = HttpRequest.newBuilder(URI.create(cerberusUrl + "/api/public/robots"))
                .timeout(Duration.ofSeconds(15))
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header("X-API-VERSION", "1")
                .header(authHeader.name(), authHeader.value())
                .POST(HttpRequest.BodyPublishers.ofString(rawBody))
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        return new RobotResult(response.statusCode(), response.body());
    }

    private RobotResult get(String path) throws IOException, InterruptedException {
        CerberusAuthService.AuthHeader authHeader = auth.authHeader();
        String cerberusUrl = auth.cerberusUrl();
        if (cerberusUrl.isBlank()) return new RobotResult(400, "{\"error\":\"Set a Cerberus URL first\"}");
        if (authHeader == null) return new RobotResult(401, "{\"error\":\"Not authenticated\"}");

        HttpRequest request = HttpRequest.newBuilder(URI.create(cerberusUrl + path))
                .timeout(Duration.ofSeconds(10))
                .header("Accept", "application/json")
                .header("X-API-VERSION", "1")
                .header(authHeader.name(), authHeader.value())
                .GET().build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        return new RobotResult(response.statusCode(), response.body());
    }

    private static String urlEncodeSegment(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }
}
