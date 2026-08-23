#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then npm install --no-audit --no-fund; fi
( sleep 1; command -v xdg-open >/dev/null && xdg-open http://localhost:5500 >/dev/null 2>&1 || true ) &
npm start
