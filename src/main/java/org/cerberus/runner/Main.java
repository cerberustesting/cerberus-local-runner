package org.cerberus.runner;

import java.awt.Desktop;
import java.net.URI;
import java.util.concurrent.CountDownLatch;

public final class Main {
    private Main() {}

    public static void main(String[] args) throws Exception {
        RunnerConfig config = RunnerConfig.load();
        CerberusAuthService auth = new CerberusAuthService(config);
        CerberusRobotService robots = new CerberusRobotService(config, auth);
        ProcessSupervisor supervisor = new ProcessSupervisor(config);
        LocalHttpServer httpServer = new LocalHttpServer(config, supervisor, auth, robots);
        httpServer.start();

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            supervisor.stop();
            httpServer.stop();
        }, "cerberus-shutdown"));

        URI ui = URI.create("http://127.0.0.1:" + config.integer("ui.port"));
        System.out.println("Cerberus Local Runner UI: " + ui);
        System.out.println("Configuration: " + config.configFile());

        if (config.bool("openBrowser") && Desktop.isDesktopSupported()) {
            try { Desktop.getDesktop().browse(ui); } catch (Exception ignored) { }
        }
        if (config.bool("autostart")) supervisor.startAsync();
        new CountDownLatch(1).await();
    }
}

