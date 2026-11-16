#!/usr/bin/env bash
# Set up the real-instrument route (Decent Sampler and Surge XT as VST3) on Linux x86_64.
#
# It makes an isolated Python environment with pedalboard and mido, unpacks the two plug-ins and writes mcp-env.json
# with the settings for your MCP client. It does not touch system plug-in folders and does not need root.
#
# Plug-ins come from one of two places for each:
#   a download:  DECENT_SAMPLER_URL + DECENT_SAMPLER_SHA256   or   SURGE_XT_URL + SURGE_XT_SHA256
#                (.tar.gz, .tgz or .zip from the publisher; the SHA-256 is mandatory and is checked before unpacking)
#   a bundle:    --decent-sampler-bundle PATH   or   --surge-xt-bundle PATH   (a .vst3 folder you already have)
# No download address is built in: take it, and the hash, from the publisher's own release page.
#
# Usage: setup-vst3-linux.sh [--install-directory DIR] [--python python3] [--skip-python]
#                            [--decent-sampler-bundle PATH] [--surge-xt-bundle PATH]
# Any Python 3 that pedalboard supports will do; there is no version pin here.
set -euo pipefail

install_directory="${XDG_DATA_HOME:-$HOME/.local/share}/lmms-mcp/vst3-v1"
python_command="python3"
skip_python=0
decent_bundle=""
surge_bundle=""

while [ $# -gt 0 ]; do
  case "$1" in
    --install-directory) install_directory="$2"; shift 2 ;;
    --python) python_command="$2"; shift 2 ;;
    --skip-python) skip_python=1; shift ;;
    --decent-sampler-bundle) decent_bundle="$2"; shift 2 ;;
    --surge-xt-bundle) surge_bundle="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "Error: $*" >&2; exit 1; }

if [ "$(uname -s)" != "Linux" ] && [ "${LMMS_SETUP_ALLOW_ANY_OS:-0}" != "1" ]; then
  fail "this script is for Linux. On Windows use setup-vst3-windows.ps1."
fi

[ ! -e "$install_directory" ] || fail "$install_directory already exists. Use --install-directory with a new directory, or remove it first."
mkdir -p "$install_directory"
install_directory="$(cd "$install_directory" && pwd)"

# Find the .vst3 folder inside an unpacked tree, by name. Prints the first match.
find_bundle() { find "$1" -type d -name "$2" -print -quit; }

# Download, verify and unpack one plug-in. $1 name, $2 url, $3 sha256, $4 bundle name to find.
fetch_plugin() {
  local name="$1" url="$2" hash="$3" bundle_name="$4"
  [ -n "$hash" ] || fail "$name: set the SHA-256 of the download. A download without a hash is not accepted."
  command -v curl >/dev/null || fail "curl is needed to download $name."
  command -v sha256sum >/dev/null || fail "sha256sum is needed to check the $name download."
  local archive="$install_directory/$name.archive"
  curl --fail --location --silent --show-error --output "$archive" "$url"
  local actual
  actual="$(sha256sum "$archive" | cut -d' ' -f1)"
  if [ "${actual,,}" != "${hash,,}" ]; then
    rm -f "$archive"
    fail "$name: unexpected SHA-256 $actual"
  fi
  mkdir -p "$install_directory/$name"
  case "$url" in
    *.zip) command -v unzip >/dev/null || fail "unzip is needed for $name."; unzip -q "$archive" -d "$install_directory/$name" ;;
    *.tar.gz|*.tgz) tar -xzf "$archive" -C "$install_directory/$name" ;;
    *) rm -f "$archive"; fail "$name: the download must be a .zip, .tar.gz or .tgz" ;;
  esac
  rm -f "$archive"
  local found
  found="$(find_bundle "$install_directory/$name" "$bundle_name")"
  [ -n "$found" ] || fail "$name: no $bundle_name folder in the download."
  printf '%s' "$found"
}

resolve_plugin() {
  local name="$1" bundle="$2" url="$3" hash="$4" bundle_name="$5"
  if [ -n "$bundle" ]; then
    [ -d "$bundle" ] || fail "$name: $bundle is not a directory. Give the .vst3 folder, not the file inside it."
    (cd "$bundle" && pwd)
  elif [ -n "$url" ]; then
    fetch_plugin "$name" "$url" "$hash" "$bundle_name"
  else
    return 0
  fi
}

decent_path="$(resolve_plugin decent "$decent_bundle" "${DECENT_SAMPLER_URL:-}" "${DECENT_SAMPLER_SHA256:-}" "DecentSampler.vst3")"
surge_path="$(resolve_plugin surge "$surge_bundle" "${SURGE_XT_URL:-}" "${SURGE_XT_SHA256:-}" "Surge XT.vst3")"

python_path=""
if [ "$skip_python" -eq 0 ]; then
  command -v "$python_command" >/dev/null || fail "$python_command was not found. Install Python 3 with the venv module, or pass --python."
  "$python_command" -m venv "$install_directory/venv" || fail "Python virtual environment setup failed (on Debian and Ubuntu install python3-venv)."
  "$install_directory/venv/bin/python" -m pip install --disable-pip-version-check pedalboard==0.9.26 mido==1.3.3 \
    || fail "VST3 host dependency installation failed."
  python_path="$install_directory/venv/bin/python"
fi

# JSON string escape for the paths (backslash and double quote only; Linux paths hold nothing else that needs it here).
json() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
{
  echo "{"
  sep=""
  if [ -n "$python_path" ]; then printf '%s  "LMMS_VST3_PYTHON": "%s"' "$sep" "$(json "$python_path")"; sep=$',\n'; fi
  if [ -n "$decent_path" ]; then printf '%s  "LMMS_DECENT_SAMPLER_VST3": "%s"' "$sep" "$(json "$decent_path")"; sep=$',\n'; fi
  if [ -n "$surge_path" ]; then printf '%s  "LMMS_SURGE_XT_VST3": "%s"' "$sep" "$(json "$surge_path")"; sep=$',\n'; fi
  echo
  echo "}"
} > "$install_directory/mcp-env.json"

echo "Copy the environment settings from $install_directory/mcp-env.json into your MCP client's server configuration."
[ -n "$decent_path" ] || echo "No Decent Sampler yet: rerun with DECENT_SAMPLER_URL and DECENT_SAMPLER_SHA256, or --decent-sampler-bundle."
[ -n "$surge_path" ] || echo "No Surge XT yet: rerun with SURGE_XT_URL and SURGE_XT_SHA256, or --surge-xt-bundle."
