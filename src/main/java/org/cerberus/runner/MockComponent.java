package org.cerberus.runner;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;

public final class MockComponent {
    private MockComponent() {}

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "cloudflared".equals(args[0])) {
            String suffix = args.length > 1 ? "-" + args[1] : "";
            System.out.println("INF Your quick Tunnel has been created! Visit it at https://mock-runner" + suffix + ".trycloudflare.com");
            new CountDownLatch(1).await();
            return;
        }
        int port = Integer.parseInt(args[1]);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/status", exchange -> {
            byte[] body = "{\"value\":{\"ready\":true}}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        System.out.println("Mock " + args[0] + " ready on " + port);
        new CountDownLatch(1).await();
    }
}

