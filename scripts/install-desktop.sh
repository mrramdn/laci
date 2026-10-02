#!/bin/sh
# Installs a built binary and launcher without requiring a system package.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=${1:-"$repo_dir/target/release/laci"}
[ -x "$binary" ] || { echo "Build laci with pnpm build first, or pass its binary path." >&2; exit 1; }
install_root=${LACI_INSTALL_PREFIX:-"$HOME/.local"}
data_root=${XDG_DATA_HOME:-"$HOME/.local/share"}
install -Dm755 "$binary" "$install_root/bin/laci"
install -Dm644 "$repo_dir/src-tauri/icons/128x128.png" "$data_root/icons/hicolor/128x128/apps/laci.png"
mkdir -p "$data_root/applications"
cat > "$data_root/applications/laci.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=laci
Comment=Projects, their git state and agent history
Exec="$install_root/bin/laci"
Icon=laci
Terminal=false
Categories=Development;Utility;
StartupWMClass=laci
DESKTOP
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$data_root/applications" >/dev/null 2>&1 || true
fi
echo "Installed $install_root/bin/laci and $data_root/applications/laci.desktop"
