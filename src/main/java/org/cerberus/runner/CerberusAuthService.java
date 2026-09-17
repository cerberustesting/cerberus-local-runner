package org.cerberus.runner;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Authenticates the local runner against a Cerberus instance, either with a per-user
 * API key (X-API-KEY) or via an OAuth Authorization Code + PKCE flow against Keycloak.
 * Both credentials are only ever verified against the /mcp endpoint: today it is the
 * only Cerberus route that accepts either scheme outside of a browser session.
 */
final class CerberusAuthService {

    record PendingOAuth(String keycloakUrl, String realm, String clientId, String redirectUri,
                         String codeVerifier, Instant createdAt) {
    }

    /** Cerberus's own OAuth/Keycloak settings, fetched from GET /api/public/oauth-config so the user
     *  only ever has to type the Cerberus URL - not Keycloak's URL/realm/clientId by hand. */
    private record OAuthConfig(boolean enabled, String keycloakUrl, String realm, String clientId) {
    }

    /** status is one of "ok" (verified), "unknown" (saved but unverifiable, e.g. MCP disabled) or "failed". */
    record TestResult(String status, String message) {
    }

    /** The header to send on any authenticated call to Cerberus, or null if nothing is saved yet. */
    record AuthHeader(String name, String value) {
    }

    /** Refresh a token this far ahead of its expiry so an in-flight request never races the deadline. */
    private static final long TOKEN_EXPIRY_SKEW_SECONDS = 30;

    /** Used when Cerberus's /api/public/oauth-config omits localRunnerClientId. */
    private static final String DEFAULT_CLIENT_ID = "cerberus-local-runner";

    private final RunnerConfig config;
    private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    private final Map<String, PendingOAuth> pending = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();

    CerberusAuthService(RunnerConfig config) {
        this.config = config;
    }

    synchronized Map<String, Object> status() {
        String mode = config.get("cerberus.auth.mode");
        boolean authenticated;
        if ("apikey".equals(mode)) {
            // The API key itself can only be verified through /mcp, so trust the last test outcome.
            String verified = config.get("cerberus.auth.verified");
            authenticated = "ok".equals(verified) || "unknown".equals(verified);
        } else if ("oauth".equals(mode)) {
            authenticated = ensureValidOAuthSession();
        } else {
            authenticated = false;
        }
        return Map.of(
                "cerberusUrl", config.get("cerberus.url"),
                "mode", mode,
                "authenticated", authenticated,
                "login", config.get("cerberus.auth.login"),
                "keycloakUrl", config.get("cerberus.auth.oauth.keycloakUrl"),
                "realm", config.get("cerberus.auth.oauth.realm"),
                "clientId", config.get("cerberus.auth.oauth.clientId"),
                "redirectUri", redirectUri());
    }

    AuthHeader authHeader() throws IOException {
        String mode = config.get("cerberus.auth.mode");
        if ("apikey".equals(mode)) return new AuthHeader("X-API-KEY", config.get("cerberus.auth.apiKey"));
        if ("oauth".equals(mode)) return new AuthHeader("Authorization", "Bearer " + oauthAccessToken());
        return null;
    }

    /** Backs status()'s "authenticated" flag: a merely non-blank access token doesn't mean the
     *  session is still good - it just means it *was* good at some point in the past. Force the
     *  same expiry check/refresh a real API call would trigger, so a stale cached session (e.g.
     *  the refresh token itself expired or was revoked) gets caught right away and reported as
     *  logged out, instead of only surfacing as an obscure error the next time something is clicked. */
    private boolean ensureValidOAuthSession() {
        if (config.get("cerberus.auth.oauth.accessToken").isBlank()) return false;
        try {
            oauthAccessToken();
            return true;
        } catch (IOException exception) {
            return false;
        }
    }

    /** Returns a valid access token, transparently refreshing it first if it has expired (or is about to). */
    private synchronized String oauthAccessToken() throws IOException {
        long expiresAt = parseLongOrDefault(config.get("cerberus.auth.oauth.expiresAt"), 0);
        if (Instant.now().isBefore(Instant.ofEpochSecond(expiresAt).minusSeconds(TOKEN_EXPIRY_SKEW_SECONDS))) {
            return config.get("cerberus.auth.oauth.accessToken");
        }
        refreshOAuthToken();
        return config.get("cerberus.auth.oauth.accessToken");
    }

    private void refreshOAuthToken() throws IOException {
        String refreshToken = config.get("cerberus.auth.oauth.refreshToken");
        if (refreshToken.isBlank()) throw new IOException("OAuth session expired; please sign in again");

        String tokenEndpoint = config.get("cerberus.auth.oauth.keycloakUrl") + "/realms/"
                + urlEncode(config.get("cerberus.auth.oauth.realm")) + "/protocol/openid-connect/token";
        String form = "grant_type=refresh_token"
                + "&refresh_token=" + urlEncode(refreshToken)
                + "&client_id=" + urlEncode(config.get("cerberus.auth.oauth.clientId"));

        HttpRequest tokenRequest = HttpRequest.newBuilder(URI.create(tokenEndpoint))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();
        HttpResponse<String> response;
        try {
            response = httpClient.send(tokenRequest, HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while refreshing the OAuth token", exception);
        }
        if (response.statusCode() != 200) {
            // The refresh token itself is expired/revoked (e.g. idle timeout) - only a fresh sign-in can recover.
            config.set("cerberus.auth.oauth.accessToken", "");
            config.set("cerberus.auth.oauth.refreshToken", "");
            config.set("cerberus.auth.oauth.expiresAt", "0");
            config.save();
            throw new IOException("OAuth session expired; please sign in again");
        }

        String accessToken = jsonField(response.body(), "access_token");
        String newRefreshToken = jsonField(response.body(), "refresh_token");
        String expiresIn = jsonField(response.body(), "expires_in");
        if (accessToken == null) throw new IOException("Keycloak refresh response did not contain an access_token");

        long expiresAt = Instant.now().plusSeconds(parseLongOrDefault(expiresIn, 60)).getEpochSecond();
        config.set("cerberus.auth.oauth.accessToken", accessToken);
        config.set("cerberus.auth.oauth.refreshToken", newRefreshToken == null ? refreshToken : newRefreshToken);
        config.set("cerberus.auth.oauth.expiresAt", Long.toString(expiresAt));
        config.save();
    }

    String cerberusUrl() {
        return config.get("cerberus.url");
    }

    String redirectUri() {
        return "http://127.0.0.1:" + config.port() + "/oauth/callback";
    }

    // ---- API key mode -------------------------------------------------------

    synchronized TestResult saveApiKey(String cerberusUrl, String apiKey) throws IOException {
        requireNonBlank(cerberusUrl, "Cerberus URL");
        requireNonBlank(apiKey, "API key");
        config.set("cerberus.url", normalizeUrl(cerberusUrl));
        config.set("cerberus.auth.mode", "apikey");
        config.set("cerberus.auth.apiKey", apiKey.trim());
        config.save();
        return testConnection();
    }

    // ---- OAuth mode ---------------------------------------------------------

    synchronized String startOAuth(String cerberusUrl) throws IOException {
        requireNonBlank(cerberusUrl, "Cerberus URL");
        String normalizedCerberus = normalizeUrl(cerberusUrl);
        OAuthConfig oauthConfig = fetchOAuthConfig(normalizedCerberus);

        String normalizedKeycloak = oauthConfig.keycloakUrl();
        String trimmedRealm = oauthConfig.realm();
        String trimmedClientId = oauthConfig.clientId();

        config.set("cerberus.url", normalizedCerberus);
        config.set("cerberus.auth.oauth.keycloakUrl", normalizedKeycloak);
        config.set("cerberus.auth.oauth.realm", trimmedRealm);
        config.set("cerberus.auth.oauth.clientId", trimmedClientId);
        config.save();

        pending.values().removeIf(p -> p.createdAt().isBefore(Instant.now().minusSeconds(600)));

        String state = randomToken(24);
        String codeVerifier = randomToken(48);
        String codeChallenge = codeChallenge(codeVerifier);
        String redirect = redirectUri();

        pending.put(state, new PendingOAuth(normalizedKeycloak, trimmedRealm, trimmedClientId, redirect, codeVerifier, Instant.now()));

        String authorizeEndpoint = normalizedKeycloak + "/realms/" + urlEncode(trimmedRealm) + "/protocol/openid-connect/auth";

        return authorizeEndpoint
                + "?response_type=code"
                + "&client_id=" + urlEncode(trimmedClientId)
                + "&redirect_uri=" + urlEncode(redirect)
                + "&scope=" + urlEncode("openid profile email")
                + "&state=" + urlEncode(state)
                + "&code_challenge=" + urlEncode(codeChallenge)
                + "&code_challenge_method=S256";
    }

    /** GET {cerberusUrl}/api/public/oauth-config - unauthenticated by nature: it only hands back
     *  public-client discovery info (no client secret, since this is a PKCE public client), the
     *  same values Cerberus's own login page already sends the browser to redirect to Keycloak. */
    private OAuthConfig fetchOAuthConfig(String cerberusUrl) throws IOException {
        HttpResponse<String> response;
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(cerberusUrl + "/api/public/oauth-config"))
                    .timeout(Duration.ofSeconds(8))
                    .header("Accept", "application/json")
                    .GET().build();
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while fetching the OAuth configuration from Cerberus", exception);
        } catch (Exception exception) {
            String message = exception.getMessage() == null ? exception.toString() : exception.getMessage();
            throw new IOException("Could not reach Cerberus at " + cerberusUrl + " to fetch its OAuth configuration: " + message);
        }
        if (response.statusCode() != 200) {
            throw new IOException("Cerberus did not return an OAuth configuration (HTTP " + response.statusCode()
                    + "). Check the Cerberus URL, or use an API key instead if this instance doesn't support sign-in yet.");
        }
        boolean enabled = "true".equals(jsonField(response.body(), "enabled"));
        String keycloakUrl = jsonField(response.body(), "keycloakUrl");
        String realm = jsonField(response.body(), "realm");
        String clientId = jsonField(response.body(), "localRunnerClientId");
        if (!enabled || isBlank(keycloakUrl) || isBlank(realm)) {
            throw new IOException("OAuth sign-in is not enabled on this Cerberus instance; use an API key instead");
        }
        return new OAuthConfig(true, normalizeUrl(keycloakUrl), realm.trim(), isBlank(clientId) ? DEFAULT_CLIENT_ID : clientId.trim());
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    synchronized String completeOAuth(String code, String state, String errorParam, String errorDescription) throws Exception {
        if (errorParam != null && !errorParam.isBlank()) {
            throw new IOException("Keycloak returned an error: " + errorParam
                    + (errorDescription == null || errorDescription.isBlank() ? "" : " (" + errorDescription + ")"));
        }
        if (state == null) throw new IOException("Missing OAuth state");
        PendingOAuth request = pending.remove(state);
        if (request == null) throw new IOException("Unknown or expired sign-in attempt; please retry");
        if (code == null || code.isBlank()) throw new IOException("Keycloak did not return an authorization code");

        String tokenEndpoint = request.keycloakUrl() + "/realms/" + urlEncode(request.realm()) + "/protocol/openid-connect/token";
        String form = "grant_type=authorization_code"
                + "&code=" + urlEncode(code)
                + "&redirect_uri=" + urlEncode(request.redirectUri())
                + "&client_id=" + urlEncode(request.clientId())
                + "&code_verifier=" + urlEncode(request.codeVerifier());

        HttpRequest tokenRequest = HttpRequest.newBuilder(URI.create(tokenEndpoint))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();
        HttpResponse<String> response = httpClient.send(tokenRequest, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("Token exchange failed: HTTP " + response.statusCode() + " " + response.body());
        }

        String accessToken = jsonField(response.body(), "access_token");
        String refreshToken = jsonField(response.body(), "refresh_token");
        String expiresIn = jsonField(response.body(), "expires_in");
        if (accessToken == null) throw new IOException("Keycloak response did not contain an access_token");

        long expiresAt = Instant.now().plusSeconds(parseLongOrDefault(expiresIn, 60)).getEpochSecond();
        String login = fetchUserLogin(request.keycloakUrl(), request.realm(), accessToken);

        config.set("cerberus.auth.mode", "oauth");
        config.set("cerberus.auth.oauth.accessToken", accessToken);
        config.set("cerberus.auth.oauth.refreshToken", refreshToken == null ? "" : refreshToken);
        config.set("cerberus.auth.oauth.expiresAt", Long.toString(expiresAt));
        config.set("cerberus.auth.login", login == null ? "" : login);
        config.save();
        return login;
    }

    private String fetchUserLogin(String keycloakUrl, String realm, String accessToken) {
        try {
            String userInfoEndpoint = keycloakUrl + "/realms/" + urlEncode(realm) + "/protocol/openid-connect/userinfo";
            HttpRequest request = HttpRequest.newBuilder(URI.create(userInfoEndpoint))
                    .timeout(Duration.ofSeconds(8))
                    .header("Authorization", "Bearer " + accessToken)
                    .GET().build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 200) {
                String preferred = jsonField(response.body(), "preferred_username");
                return preferred != null ? preferred : jsonField(response.body(), "email");
            }
        } catch (Exception ignored) {
            // Best-effort only: the access token is still stored and usable without a display name.
        }
        return null;
    }

    // ---- connection test (against /mcp, the only route accepting either scheme today) -----

    synchronized TestResult testConnection() {
        String cerberusUrl = config.get("cerberus.url");
        if (cerberusUrl.isBlank()) return new TestResult("failed", "Set a Cerberus URL first");
        String mode = config.get("cerberus.auth.mode");
        AuthHeader authHeader;
        try {
            authHeader = authHeader();
        } catch (IOException exception) {
            return new TestResult("failed", exception.getMessage());
        }
        if (authHeader == null) return new TestResult("failed", "No credentials saved yet");

        TestResult result;
        try {
            String body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{"
                    + "\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},"
                    + "\"clientInfo\":{\"name\":\"cerberus-local-runner\",\"version\":\"1.0\"}}}";

            HttpRequest request = HttpRequest.newBuilder(URI.create(cerberusUrl + "/mcp"))
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/event-stream")
                    .header(authHeader.name(), authHeader.value())
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() == 200) {
                result = new TestResult("ok", "Connected" + loginSuffix());
            } else if (response.statusCode() == 401) {
                result = new TestResult("failed", "Unauthorized: credentials were rejected by Cerberus");
            } else if (response.statusCode() == 403) {
                // McpApiKeyAuthFilter checks the cerberus_mcp_enable toggle before ever looking at the
                // credentials, so a 403 here says nothing about whether the key/token itself is valid.
                result = new TestResult("unknown", "Saved. Could not verify: the MCP endpoint is disabled on "
                        + "this Cerberus instance (cerberus_mcp_enable parameter)");
            } else {
                result = new TestResult("failed", "Unexpected response: HTTP " + response.statusCode());
            }
        } catch (Exception exception) {
            String message = exception.getMessage() == null ? exception.toString() : exception.getMessage();
            result = new TestResult("failed", "Connection failed: " + message);
        }

        if ("apikey".equals(mode)) {
            config.set("cerberus.auth.verified", result.status());
            try {
                config.save();
            } catch (IOException ignored) {
                // The in-memory result is still returned; only the on-disk cache write failed.
            }
        }
        return result;
    }

    private String loginSuffix() {
        String login = config.get("cerberus.auth.login");
        return login.isBlank() ? "" : " as " + login;
    }

    synchronized void logout() throws IOException {
        config.set("cerberus.auth.mode", "");
        config.set("cerberus.auth.apiKey", "");
        config.set("cerberus.auth.verified", "");
        config.set("cerberus.auth.login", "");
        config.set("cerberus.auth.oauth.accessToken", "");
        config.set("cerberus.auth.oauth.refreshToken", "");
        config.set("cerberus.auth.oauth.expiresAt", "0");
        config.save();
    }

    // ---- helpers --------------------------------------------------------------

    private static void requireNonBlank(String value, String label) throws IOException {
        if (value == null || value.isBlank()) throw new IOException(label + " is required");
    }

    private static String normalizeUrl(String url) {
        String trimmed = url.trim();
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) trimmed = "https://" + trimmed;
        return trimmed;
    }

    private static String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private String randomToken(int byteLength) {
        byte[] bytes = new byte[byteLength];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String codeChallenge(String codeVerifier) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(codeVerifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (Exception exception) {
            throw new IllegalStateException(exception);
        }
    }

    private static long parseLongOrDefault(String value, long fallback) {
        try {
            return value == null ? fallback : Long.parseLong(value);
        } catch (NumberFormatException exception) {
            return fallback;
        }
    }

    /** Extracts one top-level string/number/boolean field from a small, flat JSON object (no JSON library on the classpath). */
    static String jsonField(String json, String field) {
        if (json == null) return null;
        String quotedField = Pattern.quote(field);
        Matcher stringMatcher = Pattern.compile("\"" + quotedField + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"").matcher(json);
        if (stringMatcher.find()) return stringMatcher.group(1).replace("\\\"", "\"").replace("\\\\", "\\");
        Matcher numberMatcher = Pattern.compile("\"" + quotedField + "\"\\s*:\\s*(-?\\d+)").matcher(json);
        if (numberMatcher.find()) return numberMatcher.group(1);
        Matcher booleanMatcher = Pattern.compile("\"" + quotedField + "\"\\s*:\\s*(true|false)").matcher(json);
        if (booleanMatcher.find()) return booleanMatcher.group(1);
        return null;
    }
}
