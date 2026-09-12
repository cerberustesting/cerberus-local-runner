#!/usr/bin/env bash
# Shared helpers for build-macos.sh / build-linux.sh. Not meant to be run directly.

# Looks up "<key>=<url>" in the given dependencies.<os>.txt manifest and prints the url.
dependency_url() {
  local deps_file="$1" key="$2"
  [[ -f "$deps_file" ]] || { echo "Missing dependency manifest: $deps_file" >&2; exit 1; }

  local line
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$deps_file" | head -1)"
  [[ -n "$line" ]] || { echo "Missing dependency '$key' in $deps_file" >&2; exit 1; }
  echo "${line#*=}"
}

# Downloads the given manifest's <key> into $input_dir/<dest-filename>.
fetch_dependency() {
  local deps_file="$1" input_dir="$2" key="$3" dest="$4"
  local url
  url="$(dependency_url "$deps_file" "$key")"
  echo "Fetching $dest <- $url"
  curl -fSL "$url" -o "$input_dir/$dest"
}
