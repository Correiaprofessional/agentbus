#!/usr/bin/env bash
# Build desktop/AgentBus.app — a menu bar app with no dependencies.
#   ./desktop/build.sh          build in place
#   ./desktop/build.sh --install  build, then copy to /Applications
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
APP=AgentBus.app

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found — install the Xcode command line tools: xcode-select --install" >&2
  exit 1
fi

if [ ! -f AgentBus.icns ] || [ ! -f MenuBarTemplate.png ]; then
  node "$ROOT/scripts/make-icon.mjs"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -swift-version 5 -O AgentBus.swift -o "$APP/Contents/MacOS/AgentBus" -framework Cocoa

cp AgentBus.icns "$APP/Contents/Resources/AgentBus.icns"
cp MenuBarTemplate.png MenuBarTemplate@2x.png "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>agentbus</string>
  <key>CFBundleDisplayName</key><string>agentbus</string>
  <key>CFBundleIdentifier</key><string>dev.agentbus.menubar</string>
  <key>CFBundleExecutable</key><string>AgentBus</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>AgentBus</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "warning: ad-hoc code signing failed (the app still runs)"
echo "built $PWD/$APP"

if [ "${1:-}" = "--install" ]; then
  rm -rf "/Applications/$APP"
  ln -s "$PWD/$APP" "/Applications/$APP"
  echo "linked /Applications/$APP -> $PWD/$APP"
  echo "(a copy would lose the path back to bin/agentbus.js; it also falls back to agentbus on PATH)"
fi
