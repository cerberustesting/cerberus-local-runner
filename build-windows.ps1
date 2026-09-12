#!/usr/bin/env pwsh
<#
Usage: ./build-windows.ps1
Downloads selenium-server.jar, cerberus-extension.jar and cloudflared.exe per dependencies.windows.txt.
Set $env:CERBERUS_ROBOT_PROXY = "true" to also download cerberus-robot-proxy.jar and mitmdump.exe
(bundled directly - no code-signing constraint here, unlike macOS).
#>

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$depsFile = Join-Path $projectDir "dependencies.windows.txt"
$includeRobotProxy = $env:CERBERUS_ROBOT_PROXY -eq "true"
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

# Looks up "<key>=<url>" in the given dependencies.<os>.txt manifest and returns the url.
function Get-DependencyUrl {
    param([string]$DepsFile, [string]$Key)

    if (-not (Test-Path $DepsFile -PathType Leaf)) { throw "Missing dependency manifest: $DepsFile" }
    $match = Get-Content $DepsFile | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
    if (-not $match) { throw "Missing dependency '$Key' in $DepsFile" }
    return ($match -split "=", 2)[1]
}

# Downloads the given manifest's <Key> into $InputDir/<Dest>.
function Fetch-Dependency {
    param([string]$DepsFile, [string]$InputDir, [string]$Key, [string]$Dest)

    $url = Get-DependencyUrl -DepsFile $DepsFile -Key $Key
    Write-Output "Fetching $Dest <- $url"
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $InputDir $Dest)
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

Fetch-Dependency -DepsFile $depsFile -InputDir $inputDir -Key "seleniumServer" -Dest "selenium-server.jar"
Fetch-Dependency -DepsFile $depsFile -InputDir $inputDir -Key "cerberusExtension" -Dest "cerberus-extension.jar"
Fetch-Dependency -DepsFile $depsFile -InputDir $inputDir -Key "cloudflared" -Dest "cloudflared.exe"

if ($includeRobotProxy) {
    Fetch-Dependency -DepsFile $depsFile -InputDir $inputDir -Key "cerberusRobotProxy" -Dest "cerberus-robot-proxy.jar"
    # No macOS-style code-signing constraint here, so mitmdump is bundled directly next to the other jars.
    Fetch-Dependency -DepsFile $depsFile -InputDir $inputDir -Key "mitmdump" -Dest "mitmdump.exe"
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
if ($includeRobotProxy) {
    Write-Output "Robot Proxy jar and mitmdump.exe bundled - nothing else to install."
}