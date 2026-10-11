#!/usr/bin/env bash
# Installation de MyGCFlow pour l'utilisateur courant, depuis l'archive tar.gz
# extraite (rien d'administrateur : tout vit sous $HOME/.local) :
#
#   programme : ~/.local/opt/MyGCFlow
#   lanceur   : ~/.local/bin/mygcflow  (sur le PATH de la plupart des sessions)
#   menu      : ~/.local/share/applications/MyGCFlow.desktop
#   icône     : ~/.local/share/icons/hicolor/256x256/apps/mygcflow.png
#
#   ./install.sh               installation
#   ./install.sh --uninstall   désinstallation (les données sont conservées)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# install.sh est livré dans le dossier MyGCFlow de l'archive : la racine de
# l'extraction est le dossier parent.
BUNDLE_DIR="$SCRIPT_DIR/../MyGCFlow"

OPT_DIR="$HOME/.local/opt/MyGCFlow"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
HICOLOR_DIR="$HOME/.local/share/icons/hicolor"

refresh_caches() {
    # Recrée les bases du menu et du thème d'icônes quand les outils existent.
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$APPS_DIR" || true
    fi
    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -q "$HICOLOR_DIR" || true
    fi
}

if [ "${1:-}" = "--uninstall" ]; then
    echo "== Désinstallation de MyGCFlow"
    rm -f "$BIN_DIR/mygcflow"
    rm -f "$APPS_DIR/MyGCFlow.desktop"
    rm -f "$ICON_DIR/mygcflow.png"
    rm -rf "$OPT_DIR"
    refresh_caches
    echo "== Terminé (les données de ~/.local/share/MyGCFlow sont conservées)"
    exit 0
fi

if [ ! -f "$BUNDLE_DIR/MyGCFlow" ]; then
    echo "Programme introuvable : $BUNDLE_DIR/MyGCFlow" >&2
    echo "Lancez install.sh depuis le dossier MyGCFlow de l'archive extraite." >&2
    exit 1
fi

echo "== Copie du programme vers $OPT_DIR"
rm -rf "$OPT_DIR"
mkdir -p "$(dirname "$OPT_DIR")"
cp -r "$BUNDLE_DIR" "$OPT_DIR"

echo "== Lanceur $BIN_DIR/mygcflow"
mkdir -p "$BIN_DIR"
ln -sf "$OPT_DIR/MyGCFlow" "$BIN_DIR/mygcflow"

echo "== Entrée de menu"
mkdir -p "$APPS_DIR"
cp "$OPT_DIR/MyGCFlow.desktop" "$APPS_DIR/MyGCFlow.desktop"

echo "== Icône"
icon="$(find "$OPT_DIR/_internal/static/img" -name 'mygcflow-icon.png' -print -quit 2>/dev/null || true)"
if [ -n "$icon" ]; then
    mkdir -p "$ICON_DIR"
    cp "$icon" "$ICON_DIR/mygcflow.png"
else
    echo "   icône introuvable dans le paquet, étape ignorée"
fi

refresh_caches
echo "== Terminé : lancez « mygcflow » ou MyGCFlow depuis le menu des applications"
