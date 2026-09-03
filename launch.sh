#!/bin/bash
# Arranca Kanban.app. El servidor web es opcional (solo para el navegador).
set -u
cd "$(dirname "$0")"
DIR="$(pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/sbin:$PATH"

PORT=3456
APP=""
for candidate in "/Applications/Kanban.app" "$HOME/Applications/Kanban.app" "$DIR/Kanban.app"; do
    if [ -d "$candidate" ]; then
        APP="$candidate"
        break
    fi
done

if [ -n "$APP" ]; then
    echo "🚀  Abriendo $APP"
    open "$APP"
    exit 0
fi

echo "⚠️  Kanban.app no está en /Applications."
echo "    Reconstruí con: bash \"$DIR/build-app.sh\""

if ! lsof -ti:"$PORT" >/dev/null 2>&1; then
    if command -v node >/dev/null 2>&1; then
        echo "📋  Arrancando servidor en http://127.0.0.1:$PORT"
        nohup node "$DIR/server.js" > "$HOME/Library/Logs/kanban-server.log" 2>&1 &
        sleep 0.4
    else
        echo "❌  No encontré node. Instalá Node o reconstrui la .app."
        exit 1
    fi
fi

open "http://127.0.0.1:$PORT"
