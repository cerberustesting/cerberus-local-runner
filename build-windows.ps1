#!/usr/bin/env pwsh
<#
Usage: ./build-windows.ps1 <selenium-server.jar> <cerberus-extension.jar> <cloudflared.exe> [cerberus-robot-proxy.jar]
The last one is optional - only needed for the Robot Proxy feature. mitmproxy itself is NOT bundled:
install it separately (e.g. via the mitmproxy Windows installer) or point the app's mitmproxy.binary
config at an absolute path to your own mitmdump.exe install.
#>
param(
    [Parameter(Mandatory = $true)][string]$SeleniumJar,
    [Parameter(Mandatory = $true)][string]$ExtensionJar,
    [Parameter(Mandatory = $true)][string]$CloudflaredExe,
    [string]$RobotProxyJar = ""
)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $projectDir "build"
$inputDir = Join-Path $buildDir "input"
$classesDir = Join-Path $buildDir "classes"
$distDir = Join-Path $projectDir "dist"
$iconPath = Join-Path $projectDir "packaging\windows\cerberus.ico"

foreach ($tool in "java", "javac", "jar", "jlink", "jpackage") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is required on PATH"
    }
}
foreach ($sourceFile in $SeleniumJar, $ExtensionJar, $CloudflaredExe) {
    if (-not (Test-Path $sourceFile -PathType Leaf)) {
        throw "Missing file: $sourceFile"
    }
}
if ($RobotProxyJar -ne "" -and -not (Test-Path $RobotProxyJar -PathType Leaf)) {
    throw "Missing file: $RobotProxyJar"
}

# See build-macos.sh for why this must be a JDK 21+ jlink/jpackage: the bundled runtime
# launches cerberus-extension.jar (compiled for Java 21) as a subprocess at startup.
$javaVersionOutput = (& java -version 2>&1) -join "`n"
if ($javaVersionOutput -notmatch '"(\d+)') {
    throw "Could not detect java version on PATH"
}
$javaMajor = [int]$Matches[1]
if ($javaMajor -lt 21) {
    throw "java on PATH is version $javaMajor, but cerberus-extension.jar requires Java 21+."
}

if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
if (Test-Path $distDir) { Remove-Item -Recurse -Force $distDir }
New-Item -ItemType Directory -Force -Path $classesDir, $inputDir, $distDir | Out-Null

$sourceFiles = Get-ChildItem -Path (Join-Path $projectDir "src\main\java") -Recurse -Filter "*.java" | ForEach-Object { $_.FullName }
& javac --release 17 --add-modules jdk.httpserver -d $classesDir $sourceFiles
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Copy-Item -Path (Join-Path $projectDir "src\main\resources\*") -Destination $classesDir -Recurse -Force

& jar --create --file (Join-Path $inputDir "cerberus-local-runner.jar") --main-class org.cerberus.runner.Main -C $classesDir .
if ($LASTEXITCODE -ne 0) { throw "jar failed" }

Copy-Item $SeleniumJar (Join-Path $inputDir "selenium-server.jar") -Force
Copy-Item $ExtensionJar (Join-Path $inputDir "cerberus-extension.jar") -Force
Copy-Item $CloudflaredExe (Join-Path $inputDir "cloudflared.exe") -Force
if ($RobotProxyJar -ne "") {
    Copy-Item $RobotProxyJar (Join-Path $inputDir "cerberus-robot-proxy.jar") -Force
}

& jlink --add-modules ALL-MODULE-PATH --strip-debug --no-header-files --no-man-pages --output (Join-Path $buildDir "runtime")
if ($LASTEXITCODE -ne 0) { throw "jlink failed" }

$jpackageArgs = @(
    "--name", "Cerberus Local Runner",
    "--app-version", "1.0.1",
    "--vendor", "Cerberus Testing",
    "--description", "Runs Cerberus Selenium tests on this machine",
    "--win-shortcut",
    "--win-menu",
    "--input", $inputDir,
    "--main-jar", "cerberus-local-runner.jar",
    "--main-class", "org.cerberus.runner.Main",
    "--runtime-image", (Join-Path $buildDir "runtime"),
    "--java-options", "--add-modules=jdk.httpserver",
    "--dest", $distDir
)

if (Test-Path $iconPath) {
    $jpackageArgs += @("--icon", $iconPath)
} else {
    Write-Warning "No icon found at $iconPath - packaging without a custom icon."
}

& jpackage --type app-image @jpackageArgs
if ($LASTEXITCODE -ne 0) { throw "jpackage app-image failed" }

& jpackage --type exe @jpackageArgs
if ($LASTEXITCODE -ne 0) { throw "jpackage exe failed (requires WiX Toolset v3 on PATH)" }

Write-Output "Created: $distDir\Cerberus Local Runner\"
Write-Output "Created .exe installer in: $distDir"
if ($RobotProxyJar -ne "") {
    Write-Output "Robot Proxy jar bundled - set mitmproxy.binary (in the app's config) to your mitmdump.exe install (PATH or absolute path) before enabling it."
}