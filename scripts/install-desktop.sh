#!/bin/sh
# Installs a built binary and launcher without requiring a system package.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=${1:-"$repo_dir/target/release/laci"}
[ -x "$binary" ] || { echo "Build laci with pnpm build first, or pass its binary path." >&2; exit 1; }
install_root=${LACI_INSTALL_PREFIX:-"$HOME/.local"}
data_root=${XDG_DATA_HOME:-"$install_root/share"}
mkdir -p "$install_root" "$data_root"
install_root=$(CDPATH= cd -- "$install_root" && pwd)
data_root=$(CDPATH= cd -- "$data_root" && pwd)
install -Dm755 "$binary" "$install_root/bin/laci"
icons="$repo_dir/src-tauri/icons"
hicolor="$data_root/icons/hicolor"
# The icons the packages install: PNGs from 16 to 512 px, the scalable icon and GNOME's symbolic one.
for size in 16 24 32 48 64 128; do
  install -Dm644 "$icons/${size}x${size}.png" "$hicolor/${size}x${size}/apps/laci.png"
done
install -Dm644 "$icons/128x128@2x.png" "$hicolor/256x256/apps/laci.png"
install -Dm644 "$icons/icon.png" "$hicolor/512x512/apps/laci.png"
install -Dm644 "$icons/icon.svg" "$hicolor/scalable/apps/laci.svg"
install -Dm644 "$icons/laci-symbolic.svg" "$hicolor/symbolic/apps/laci-symbolic.svg"
# Absolute icons also resolve in Qt launchers before their theme cache is refreshed.
icon_path="$hicolor/128x128/apps/laci.png"
exec_path=$(printf '%s' "$install_root/bin/laci" | sed 's/[\\"`$]/\\\\&/g; s/%/%%/g')
mkdir -p "$data_root/applications"
cat > "$data_root/applications/laci.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Laci
Comment=Projects, their git state and agent history
Exec="$exec_path"
Icon=$icon_path
Terminal=false
Categories=Development;Utility;
StartupWMClass=laci
DESKTOP
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$data_root/applications" >/dev/null 2>&1 || true
fi
# GTK looks icons up in icon-theme.cache instead of the folders when there is one, so refresh it to list these.
# Without a cache GTK reads the folders; creating one would hide icons other apps add later without refreshing it.
if [ -f "$hicolor/icon-theme.cache" ] && command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -f -t "$hicolor" >/dev/null 2>&1 || true
fi
echo "Installed $install_root/bin/laci and $data_root/applications/laci.desktop"
