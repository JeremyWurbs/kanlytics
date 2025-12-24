#!/usr/bin/env sh
set -eu

BACKEND_PORT="${KANLYTICS_BACKEND_PORT:-8080}"
FRONTEND_PORT="${KANLYTICS_FRONTEND_PORT:-5173}"

# If a Docker secret is mounted, export it as a GitHub token env var.
# The backend already auto-detects from env vars like GITHUB_TOKEN / GH_TOKEN.
PAT_FILE="${KANLYTICS_GITHUB_PAT_FILE:-/run/secrets/kanlytics_github_pat}"
if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GITHUB_PAT:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
  if [ -f "$PAT_FILE" ]; then
    # trim trailing newlines/spaces
    TOKEN="$(cat "$PAT_FILE" | tr -d '\r' | awk '{printf "%s", $0}')"
    if [ -n "$TOKEN" ]; then
      export GITHUB_TOKEN="$TOKEN"
    fi
  fi
fi

# Frontend API base (Vite reads VITE_* at runtime for dev server).
if [ -z "${VITE_API_BASE:-}" ]; then
  export VITE_API_BASE="http://localhost:${BACKEND_PORT}"
fi

# Backend CORS: allow the frontend origin for the chosen frontend port.
if [ -z "${KANLYTICS_CORS_ORIGINS:-}" ]; then
  export KANLYTICS_CORS_ORIGINS="http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}"
fi

echo "Starting Kanlytics backend on :${BACKEND_PORT}"
# NOTE: KanlyticsBackend.launch(...) starts the actual server as a subprocess and (by design)
# returns after the server is reachable. If this parent Python process exits, the launched
# server may be terminated as well. Keep this parent process alive.
python -u -c "from kanlytics.services.kanlytics_backend import KanlyticsBackend; KanlyticsBackend.launch(url='http://0.0.0.0:${BACKEND_PORT}/', timeout=15); import time; time.sleep(10**9)" &
BACKEND_PID="$!"

cleanup() {
  if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

echo "Starting Kanlytics frontend on :${FRONTEND_PORT}"
echo "Open: http://localhost:${FRONTEND_PORT}/"
cd /app/kanlytics/frontend
exec npm run dev -- --host 0.0.0.0 --port "${FRONTEND_PORT}"
