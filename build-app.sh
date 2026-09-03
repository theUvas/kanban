#!/bin/bash
# Empaqueta Kanban como .app nativa en /Applications y en esta carpeta.
set -euo pipefail

APP_NAME="Kanban"
KDIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="/Applications/$APP_NAME.app"
if [ ! -w /Applications ]; then
    OUTPUT="$HOME/Applications/$APP_NAME.app"
    mkdir -p "$HOME/Applications"
fi

echo "🔨  Construyendo $APP_NAME.app…"

ELECTRON_APP="$KDIR/node_modules/electron/dist/Electron.app"
if [ ! -d "$ELECTRON_APP" ]; then
    echo "❌  Electron no instalado. Ejecutá en la carpeta kanban: npm install"
    exit 1
fi

rm -rf "$OUTPUT"
cp -R "$ELECTRON_APP" "$OUTPUT"
mv "$OUTPUT/Contents/MacOS/Electron" "$OUTPUT/Contents/MacOS/Kanban"
cp "$KDIR/Resources/Info.plist" "$OUTPUT/Contents/Info.plist"

APPDIR="$OUTPUT/Contents/Resources/app"
mkdir -p "$APPDIR"
cp "$KDIR/main.js" "$APPDIR/"
cp "$KDIR/preload.js" "$APPDIR/"
cp "$KDIR/tray-menu.js" "$APPDIR/"
cp "$KDIR/google-sync.js" "$APPDIR/"
cp "$KDIR/grok-chat.js" "$APPDIR/"
cp "$KDIR/google-oauth-client.json" "$APPDIR/" 2>/dev/null || true
cp "$KDIR/index.html" "$APPDIR/"
cp "$KDIR/package.json" "$APPDIR/"
cp "$KDIR/trayTemplate.png" "$APPDIR/" 2>/dev/null || true
cp "$KDIR/trayTemplate@2x.png" "$APPDIR/" 2>/dev/null || true
cp "$KDIR"/prio-*.png "$APPDIR/" 2>/dev/null || true
cp "$KDIR/manifest.json" "$APPDIR/" 2>/dev/null || true
cp "$KDIR/icon-192.png" "$APPDIR/" 2>/dev/null || true
cp "$KDIR/icon-512.png" "$APPDIR/" 2>/dev/null || true
cp "$KDIR/icon-512.png" "$OUTPUT/Contents/Resources/" 2>/dev/null || true

if [ -f "$KDIR/icon-512.png" ] && command -v sips >/dev/null; then
    ICONSET="$OUTPUT/Contents/Resources/Kanban.iconset"
    mkdir -p "$ICONSET"
    for SZ in 16 32 64 128 256 512; do
        HALF=$((SZ / 2))
        sips -z $HALF $HALF "$KDIR/icon-512.png" --out "$ICONSET/icon_${HALF}x${HALF}.png" >/dev/null 2>&1
        sips -z $SZ $SZ "$KDIR/icon-512.png" --out "$ICONSET/icon_${SZ}x${SZ}@2x.png" >/dev/null 2>&1
    done
    iconutil -c icns "$ICONSET" -o "$OUTPUT/Contents/Resources/Kanban.icns" 2>/dev/null || true
    rm -rf "$ICONSET"
    rm -f "$OUTPUT/Contents/Resources/electron.icns" 2>/dev/null || true
fi

echo "🔐  Firmando la app…"
codesign --sign - --force --deep "$OUTPUT" >/dev/null 2>&1 || echo "⚠️  No se pudo firmar (puede seguir funcionando)"
xattr -dr com.apple.quarantine "$OUTPUT" 2>/dev/null || true
xattr -cr "$OUTPUT" 2>/dev/null || true

# Copia local para que el launcher de la carpeta también funcione
rm -rf "$KDIR/Kanban.app"
cp -R "$OUTPUT" "$KDIR/Kanban.app"

echo ""
echo "✅  Listo → $OUTPUT"
echo "    Copia local → $KDIR/Kanban.app"
echo "    Abrí con: open \"$OUTPUT\""
