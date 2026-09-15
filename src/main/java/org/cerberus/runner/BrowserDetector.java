package org.cerberus.runner;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Best-effort, purely informational detection of common browsers installed on this machine
 * (checked by well-known install location per OS, or by name on PATH on Linux). Selenium Manager
 * (bundled in selenium-server.jar) still does its own resolution when a test actually launches a
 * browser - this only lets the UI show the user what's realistically available to test with.
 */
final class BrowserDetector {

    record Browser(String name, boolean available) {
    }

    private BrowserDetector() {
    }

    static List<Browser> detect() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("win")) return detectWindows();
        if (os.contains("mac") || os.contains("darwin")) return detectMac();
        return detectLinux();
    }

    private static List<Browser> detectMac() {
        return List.of(
                new Browser("Chrome", macAppExists("Google Chrome.app")),
                new Browser("Firefox", macAppExists("Firefox.app")),
                new Browser("Edge", macAppExists("Microsoft Edge.app")),
                new Browser("Safari", macAppExists("Safari.app")));
    }

    private static boolean macAppExists(String appName) {
        return new File("/Applications", appName).exists() || new File("/System/Applications", appName).exists();
    }

    private static List<Browser> detectWindows() {
        return List.of(
                new Browser("Chrome", windowsExists("Google\\Chrome\\Application\\chrome.exe")),
                new Browser("Firefox", windowsExists("Mozilla Firefox\\firefox.exe")),
                new Browser("Edge", windowsExists("Microsoft\\Edge\\Application\\msedge.exe")));
    }

    /** Checked under Program Files, Program Files (x86) and the per-user LOCALAPPDATA, since
     *  Chrome/Edge commonly install per-user there without admin rights. */
    private static boolean windowsExists(String relativePath) {
        for (String envVar : new String[]{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"}) {
            String base = System.getenv(envVar);
            if (base != null && !base.isBlank() && new File(base, relativePath).exists()) return true;
        }
        return false;
    }

    private static List<Browser> detectLinux() {
        return List.of(
                new Browser("Chrome", onPath("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")),
                new Browser("Firefox", onPath("firefox", "firefox-esr")),
                new Browser("Edge", onPath("microsoft-edge", "microsoft-edge-stable")));
    }

    private static boolean onPath(String... executableNames) {
        String path = System.getenv("PATH");
        if (path == null) return false;
        for (String dir : path.split(File.pathSeparator)) {
            for (String name : executableNames) {
                if (Files.isExecutable(Path.of(dir, name))) return true;
            }
        }
        return false;
    }
}