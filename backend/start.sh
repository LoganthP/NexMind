#!/usr/bin/env bash
# One-command start for macOS / Linux: creates .venv, installs dependencies, starts the local server.
set -e
cd "$(dirname "$0")"
PY=${PYTHON:-python3}
[ -d .venv ] || $PY -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.txt
[ -f .env ] || cp .env.example .env
exec .venv/bin/python -m nexmind serve "$@"
