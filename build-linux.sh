#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 0 ]]; then
  echo "Usage: $0" >&2
  echo "Downloads selenium-server.jar, cerberus-extension.jar and cloudflared per dependencies.linux.txt." >&2
  echo "Set CERBERUS_ROBOT_PROXY=true to also download cerberus-robot-proxy.jar and mitmdump (bundled" >&2
  echo "directly - no code-signing constraint here, unlike macOS)." >&2
  exit 2
fi

project_dir="$(cd "$(dirname "$0")" && pwd)"
source "$project_dir/build-lib.sh"
deps_file="$project_dir/dependencies.linux.txt"
include_robotproxy="${CERBERUS_ROBOT_PROXY:-false}"
build_dir="$project_dir/build"
input_dir="$build_dir/input"
classes_dir="$build_dir/classes"
dist_dir="$project_dir/dist"
icon_path="$project_dir/packaging/linux/cerberus.png"

for required in java javac jar jlink jpackage curl; do
  command -v "$required" >/dev/null || { echo "$required is required" >&2; exit 1; }
done

# See build-macos.sh for why this must be a JDK 21+ jlink/jpackage: the bundled runtime
# launches cerberus-extension.jar (compiled for Java 21) as a subprocess at startup.
java_major="$(java -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"')"
if [[ -z "$java_major" || "$java_major" -lt 21 ]]; then
  echo "java on PATH is version ${java_major:-unknown}, but cerberus-extension.jar requires Java 21+." >&2
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
  # No macOS-style code-signing constraint here, so mitmdump is bundled directly next to the other jars.
  fetch_dependency "$deps_file" "$input_dir" "mitmdump" "mitmdump"
  chmod +x "$input_dir/mitmdump"
fi

jlink --add-modules ALL-MODULE-PATH \
  --strip-debug \
  --no-header-files \
  --no-man-pages \
  --output "$build_dir/runtime"

jpackage_args=(
  --name "Cerberus Local Runner"
  --app-version "1.0.1"
  --vendor "Cerberus Testing"
  --description "Runs Cerberus Selenium tests on this machine"
  --linux-package-name "cerberus-local-runner"
  --linux-shortcut
  --input "$input_dir"
  --main-jar "cerberus-local-runner.jar"
  --main-class "org.cerberus.runner.Main"
  --runtime-image "$build_dir/runtime"
  --java-options "--add-modules=jdk.httpserver"
  --dest "$dist_dir"
)

if [[ -f "$icon_path" ]]; then
  jpackage_args+=(--icon "$icon_path")
else
  echo "No icon found at $icon_path - packaging without a custom icon." >&2
fi

jpackage --type app-image "${jpackage_args[@]}"
jpackage --type deb "${jpackage_args[@]}"

echo "Created: $dist_dir/Cerberus Local Runner/"
echo "Created .deb in: $dist_dir"
if [[ "$include_robotproxy" == "true" ]]; then
  echo "Robot Proxy jar and mitmdump bundled - nothing else to install."
fi