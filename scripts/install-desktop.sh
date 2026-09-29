#!/bin/sh
# Adds laci to your app launcher. Remove with: rm ~/.local/share/applications/laci.desktop
set -e
dir=$(cd "$(dirname "$0")/.." && pwd)
electron="$dir/node_modules/electron/dist/electron"
[ -x "$electron" ] || { echo "Run pnpm install in $dir first"; exit 1; }
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/laci.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=laci
Comment=Projects, their git state and agent history
Exec="$electron" "$dir/electron/main.mjs"
Icon=folder-development
Terminal=false
Categories=Development;Utility;
StartupWMClass=laci
DESKTOP
echo "Installed ~/.local/share/applications/laci.desktop"
