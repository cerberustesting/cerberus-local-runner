#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 0 ]]; then
  echo "Usage: $0" >&2
  echo "Downloads selenium-server.jar, cerberus-extension.jar and cloudflared per dependencies.txt." >&2
  echo "Set CERBERUS_ROBOT_PROXY=true to also download cerberus-robot-proxy.jar. mitmdump itself is NOT bundled:" >&2
  echo "jpackage ad-hoc re-signs every file it packages and fails on mitmproxy.app's own already-signed binaries" >&2
  echo "(and re-signing them ourselves first still gets killed by the kernel - hardened-runtime entitlements aren't" >&2
  echo "enough to make that safe). Install mitmproxy separately (e.g. 'brew install mitmproxy') or point the app's" >&2
  echo "mitmproxy.binary config at an absolute path to an untouched mitmproxy.app you already have." >&2
  exit 2
fi

project_dir="$(cd "$(dirname "$0")" && pwd)"
source "$project_dir/build-lib.sh"
deps_file="$project_dir/dependencies.mac.txt"
include_robotproxy="${CERBERUS_ROBOT_PROXY:-false}"
build_dir="$project_dir/build"
input_dir="$build_dir/input"
classes_dir="$build_dir/classes"
dist_dir="$project_dir/dist"

for required in java javac jar jlink jpackage curl; do
  command -v "$required" >/dev/null || { echo "$required is required" >&2; exit 1; }
done

# The bundled runtime image (jlink, below) is built from whichever JDK's tools are on PATH right
# now, and that exact runtime is also what launches cerberus-extension.jar as a subprocess at
# startup - that jar is compiled for Java 21, so a 17-or-older jlink here would package a runtime
# that can start our own app but throws UnsupportedClassVersionError launching the extension.
java_major="$(java -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"')"
if [[ -z "$java_major" || "$java_major" -lt 21 ]]; then
  echo "java on PATH is version ${java_major:-unknown}, but cerberus-extension.jar requires Java 21+." >&2
  echo "Put a JDK 21+ first on PATH, e.g.: export PATH=\"\$(brew --prefix openjdk@21)/bin:\$PATH\"" >&2
  exit 1
fi

rm -rf "$build_dir" "$dist_dir"
mkdir -p "$classes_dir" "$input_dir" "$dist_dir"

javac --release 17 --add-modules jdk.httpserver \
  -d "$classes_dir" \
  $(find "$project_dir/src/main/java" -name '*.java' -print)
cp -R "$project_dir/src/main/resources/." "$classes_dir/"
jar --create --file "$input_dir/cerberus-local-runner.jar" \
  --main-class org.cerberus.runner.Main \
  -C "$classes_dir" .
fetch_dependency "$deps_file" "$input_dir" "seleniumServer" "selenium-server.jar"
fetch_dependency "$deps_file" "$input_dir" "cerberusExtension" "cerberus-extension.jar"
fetch_dependency "$deps_file" "$input_dir" "cloudflared" "cloudflared"
chmod +x "$input_dir/cloudflared"

if [[ "$include_robotproxy" == "true" ]]; then
  fetch_dependency "$deps_file" "$input_dir" "cerberusRobotProxy" "cerberus-robot-proxy.jar"
fi

# Selenium and third-party extensions can use a broad range of JDK modules.
# A complete runtime image is intentionally preferred for this first prototype.
jlink --add-modules ALL-MODULE-PATH \
  --strip-debug \
  --no-header-files \
  --no-man-pages \
  --output "$build_dir/runtime"

jpackage_args=(
  --name "Cerberus Local Runner"
  --app-version "1.0.1"
  --vendor "Cerberus Testing"
  --description "Runs Cerberus Selenium tests on this Mac"
  --input "$input_dir"
  --main-jar "cerberus-local-runner.jar"
  --main-class "org.cerberus.runner.Main"
  --runtime-image "$build_dir/runtime"
  --java-options "--add-modules=jdk.httpserver"
  --dest "$dist_dir"
  --icon "$project_dir/packaging/mac/cerberus.icns"
)

if [[ -n "${CERBERUS_MAC_SIGN_IDENTITY:-}" ]]; then
  jpackage_args+=(--mac-sign --mac-signing-key-user-name "$CERBERUS_MAC_SIGN_IDENTITY")
fi

jpackage --type app-image "${jpackage_args[@]}"
jpackage --type dmg "${jpackage_args[@]}"

echo "Created: $dist_dir/Cerberus Local Runner.app"
echo "Created DMG in: $dist_dir"
if [[ "$include_robotproxy" == "true" ]]; then
  echo "Robot Proxy jar bundled - set mitmproxy.binary (in the app's config) to an absolute path to your"
  echo "own mitmdump/mitmproxy.app install (or leave it as the 'mitmdump' default if it's on PATH) before enabling it."
fi
