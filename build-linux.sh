#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "Usage: $0 /path/to/selenium-server.jar /path/to/cerberus-extension.jar /path/to/cloudflared [/path/to/cerberus-robot-proxy.jar]" >&2
  echo "The last one is optional - only needed for the Robot Proxy feature. mitmproxy itself is NOT bundled:" >&2
  echo "install it separately (e.g. 'pip install mitmproxy' or your distro's package) or point the app's" >&2
  echo "mitmproxy.binary config at an absolute path to your own mitmdump install." >&2
  exit 2
fi

project_dir="$(cd "$(dirname "$0")" && pwd)"
selenium_source="$1"
extension_source="$2"
cloudflared_source="$3"
robotproxy_source="${4:-}"
build_dir="$project_dir/build"
input_dir="$build_dir/input"
classes_dir="$build_dir/classes"
dist_dir="$project_dir/dist"
icon_path="$project_dir/packaging/linux/cerberus.png"

for required in java javac jar jlink jpackage; do
  command -v "$required" >/dev/null || { echo "$required is required" >&2; exit 1; }
done
for source_file in "$selenium_source" "$extension_source" "$cloudflared_source"; do
  [[ -f "$source_file" ]] || { echo "Missing file: $source_file" >&2; exit 1; }
done
[[ -z "$robotproxy_source" || -f "$robotproxy_source" ]] || { echo "Missing file: $robotproxy_source" >&2; exit 1; }

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
cp "$selenium_source" "$input_dir/selenium-server.jar"
cp "$extension_source" "$input_dir/cerberus-extension.jar"
cp "$cloudflared_source" "$input_dir/cloudflared"
chmod +x "$input_dir/cloudflared"

if [[ -n "$robotproxy_source" ]]; then
  cp "$robotproxy_source" "$input_dir/cerberus-robot-proxy.jar"
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
if [[ -n "$robotproxy_source" ]]; then
  echo "Robot Proxy jar bundled - set mitmproxy.binary (in the app's config) to your mitmdump install (PATH or absolute path) before enabling it."
fi