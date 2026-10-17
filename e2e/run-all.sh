#!/usr/bin/env bash
set -eo pipefail

echo "=========================================================="
echo " NexMind Full-Stack QA Test Suite Runner"
echo "=========================================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TEMP_DATA_DIR="$(mktemp -d -t nexmind_qa_XXXXXX)"
echo "Created temp data dir: $TEMP_DATA_DIR"

BACKEND_PORT=8000
FRONTEND_PORT=4173

cleanup() {
  echo "Cleaning up background processes..."
  if [ -n "$PREVIEW_PID" ]; then
    kill "$PREVIEW_PID" 2>/dev/null || true
  fi
  if [ -n "$BACKEND_PID" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP_DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# 1. Build frontend
echo "Building frontend production bundle..."
(cd "$ROOT_DIR/frontend" && npm run build)

# 2. Check / start backend
PY_EXE="$ROOT_DIR/backend/.venv/bin/python"
if [ ! -f "$PY_EXE" ]; then
  PY_EXE="python3"
fi

if ! curl -s "http://127.0.0.1:$BACKEND_PORT/api/health" > /dev/null; then
  echo "Starting backend on port $BACKEND_PORT..."
  NEXMIND_DATA_DIR="$TEMP_DATA_DIR" NEXMIND_LLM_PROVIDER=offline "$PY_EXE" -m nexmind serve --port "$BACKEND_PORT" &
  BACKEND_PID=$!
  for _ in {1..20}; do
    if curl -s "http://127.0.0.1:$BACKEND_PORT/api/health" > /dev/null; then break; fi
    sleep 0.5
  done
fi

# 3. Start preview
if ! curl -s "http://127.0.0.1:$FRONTEND_PORT" > /dev/null; then
  echo "Starting vite preview on port $FRONTEND_PORT..."
  (cd "$ROOT_DIR/frontend" && npx vite preview --port "$FRONTEND_PORT") &
  PREVIEW_PID=$!
  for _ in {1..20}; do
    if curl -s "http://127.0.0.1:$FRONTEND_PORT" > /dev/null; then break; fi
    sleep 0.5
  done
fi

echo ">>> Running Phase 1: Backend pytest suite..."
(cd "$ROOT_DIR/backend" && "$PY_EXE" -m pytest tests -q)

echo ">>> Running Phase 2: Frontend typecheck..."
(cd "$ROOT_DIR/frontend" && npm run typecheck)

echo ">>> Running Phase 2: Frontend unit & component tests..."
(cd "$ROOT_DIR/frontend" && npm test)

echo ">>> Running Phase 3: Playwright E2E browser tests..."
(cd "$ROOT_DIR" && VITE_PORT="$FRONTEND_PORT" NEXMIND_PORT="$BACKEND_PORT" npx playwright test)

echo "=========================================================="
echo " ALL TESTS PASSED!"
echo "=========================================================="
