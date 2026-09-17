#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
build_dir="$project_dir/build/dev"
classes_dir="$build_dir/classes"
# Own, throwaway config directory - never the real app's ("$HOME/Library/Application
# Support/Cerberus Local Runner" and friends), so forcing mock.mode=true here can't leak into a
# real run of the packaged app.
config_dir="$build_dir/config"
config_file="$config_dir/config.properties"

mkdir -p "$classes_dir" "$config_dir"
javac --release 17 --add-modules jdk.httpserver \
  -d "$classes_dir" \
  $(find "$project_dir/src/main/java" -name '*.java' -print)
cp -R "$project_dir/src/main/resources/." "$classes_dir/"

if [[ ! -f "$config_file" ]]; then
  cp "$project_dir/config.example.properties" "$config_file"
fi

if grep -q '^mock.mode=' "$config_file"; then
  sed -i.bak 's/^mock.mode=.*/mock.mode=true/' "$config_file"
else
  printf '\nmock.mode=true\n' >> "$config_file"
fi

CRB_CONFIG_DIR="$config_dir" java --add-modules jdk.httpserver -cp "$classes_dir" org.cerberus.runner.Main
