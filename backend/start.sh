#!/usr/bin/env bash
# One-command start for macOS / Linux: creates .venv, installs dependencies, starts the local server.
set -e
cd "$(dirname "$0")"
if [ ! -d frontend_dist ] && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && [ -f ../frontend/package.json ]; then
    echo "Building frontend for local server..."
    (cd ../frontend && npm run build:local)
fi
PY=${PYTHON:-python3}
[ -d .venv ] || $PY -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.txt
[ -f .env ] || cp .env.example .env
exec .venv/bin/python -m nexmind serve "$@"
