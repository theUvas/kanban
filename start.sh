#!/bin/bash
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
URL="http://127.0.0.1:3456"

if ! command -v node >/dev/null 2>&1; then
    echo "❌  node no está en el PATH. Probá: /opt/homebrew/bin/node"
    exit 1
fi

lsof -ti:3456 | xargs kill -9 2>/dev/null || true
(open "$URL" &)
echo "📋  Kanban arrancando en $URL"
exec node server.js
