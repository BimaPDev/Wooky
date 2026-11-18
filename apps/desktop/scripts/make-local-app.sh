#!/bin/bash
# Builds a thin, local-only Wooky.app around the stock Electron.app so the Dock, menu bar
# and process list say "Wooky" instead of "Electron". The bundle is NOT redistributable:
# its Resources/app stub imports apps/desktop/dist/main.js from this checkout, which then
# spawns the server from apps/server/src and serves apps/web/dist, exactly like
# `pnpm --filter @age/desktop start`.
#
# Usage: apps/desktop/scripts/make-local-app.sh [output-dir]   (default: apps/desktop/out)
# Env:   WOOKY_AGE_HOME  AGE_HOME baked into the bundle (default: <repo>/.age-dev)
set -euo pipefail

desktop_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$desktop_dir/../.." && pwd)"
out_dir="${1:-$desktop_dir/out}"
age_home="${WOOKY_AGE_HOME:-$repo_root/.age-dev}"
bundle_id="app.wooky.desktop"
name="Wooky"

electron_bin="$(cd "$desktop_dir" && node -p 'require("electron")')"
electron_app="${electron_bin%/Contents/MacOS/Electron}"
[ -d "$electron_app" ] || { echo "Electron.app not found at $electron_app" >&2; exit 1; }
[ -f "$desktop_dir/dist/main.js" ] || { echo "Run: pnpm --filter @age/desktop build" >&2; exit 1; }
[ -f "$repo_root/apps/web/dist/index.html" ] || { echo "Run: pnpm --filter @age/web build" >&2; exit 1; }

app="$out_dir/$name.app"
pb=/usr/libexec/PlistBuddy
mkdir -p "$out_dir"
rm -rf "$app"
cp -R "$electron_app" "$app"

# Main executable and Info.plist.
mv "$app/Contents/MacOS/Electron" "$app/Contents/MacOS/$name"
plist="$app/Contents/Info.plist"
$pb -c "Set :CFBundleExecutable $name" "$plist"
$pb -c "Set :CFBundleName $name" "$plist"
$pb -c "Set :CFBundleDisplayName $name" "$plist"
$pb -c "Set :CFBundleIdentifier $bundle_id" "$plist"
$pb -c "Delete :ElectronAsarIntegrity" "$plist" 2>/dev/null || true
$pb -c "Add :LSEnvironment:AGE_HOME string $age_home" "$plist" 2>/dev/null ||
  $pb -c "Set :LSEnvironment:AGE_HOME $age_home" "$plist"
$pb -c "Add :NSAppleEventsUsageDescription string Wooky opens Terminal so you can sign in to your coding agents." "$plist" 2>/dev/null ||
  $pb -c "Set :NSAppleEventsUsageDescription Wooky opens Terminal so you can sign in to your coding agents." "$plist"

# Helpers: Chromium looks them up as "<executable> Helper*.app", so rename them to match.
fw="$app/Contents/Frameworks"
for variant in "" " (GPU)" " (Plugin)" " (Renderer)"; do
  old="$fw/Electron Helper$variant.app"
  new="$fw/$name Helper$variant.app"
  mv "$old" "$new"
  mv "$new/Contents/MacOS/Electron Helper$variant" "$new/Contents/MacOS/$name Helper$variant"
  hp="$new/Contents/Info.plist"
  for key in CFBundleExecutable CFBundleName; do
    $pb -c "Set :$key $name Helper$variant" "$hp" 2>/dev/null ||
      $pb -c "Add :$key string $name Helper$variant" "$hp"
  done
  $pb -c "Set :CFBundleIdentifier $bundle_id.helper" "$hp"
done

# App stub: Electron loads Resources/app before default_app.asar.
rm -f "$app/Contents/Resources/default_app.asar"
stub="$app/Contents/Resources/app"
mkdir -p "$stub"
cat >"$stub/package.json" <<JSON
{ "name": "wooky-local", "productName": "$name", "version": "0.0.0", "type": "module", "main": "main.mjs" }
JSON
# Finder/Dock launches get launchd's bare PATH; add the usual tool dirs so the server
# can find git and the agent CLIs. AGE_HOME also comes from LSEnvironment above.
node_bin="$(dirname "$(command -v node)")"
js() { node -p 'JSON.stringify(process.argv[1])' "$1"; }
cat >"$stub/main.mjs" <<JS
process.env.AGE_HOME ||= $(js "$age_home");
const extra = [$(js "$node_bin"), process.env.HOME + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"];
process.env.PATH = [...extra, process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"].join(":");
await import($(js "file://$desktop_dir/dist/main.js"));
JS

# Editing the bundle invalidated Electron's signature; re-sign ad hoc so macOS runs it.
codesign --force --deep --sign - "$app" >/dev/null 2>&1
touch "$app"
echo "$app"