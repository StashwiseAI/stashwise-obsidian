#!/usr/bin/env bash
# One command end-to-end: seed a throwaway database, start the backend against
# it, run the plugin's real sync engine over real HTTP into a real folder, then
# tear everything down.
#
# Nothing here touches your Stashwise account or any real vault. The database
# is a temp file, the backend runs on a spare port, and the "vault" is a temp
# directory.
#
#   ./scripts/e2e-full.sh [path-to-flow-app-backend]

set -euo pipefail

BACKEND="${1:-${STASHWISE_BACKEND:-}}"
PORT="${E2E_PORT:-8078}"
DB="/tmp/stashwise-obsidian-e2e.db"
VAULT="/tmp/stashwise-obsidian-e2e-vault"
LOG="/tmp/stashwise-obsidian-e2e-server.log"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "$BACKEND" ] || [ ! -d "$BACKEND" ]; then
  echo "Stashwise backend not found."
  echo "Pass its path as the first argument, or set STASHWISE_BACKEND."
  echo "  ./scripts/e2e-full.sh /path/to/backend"
  exit 1
fi
BACKEND="$(cd "$BACKEND" && pwd)"

cleanup() {
  # Kill by port rather than by PID: uv spawns uvicorn as a child, so the PID
  # we started is not the one holding the socket.
  pkill -f "uvicorn app.main:app --host 127.0.0.1 --port $PORT" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Seeding a throwaway database at $DB"
rm -f "$DB"
cd "$BACKEND"
DATABASE_URL="sqlite+aiosqlite:///$DB" uv run python scripts/seed_e2e_vault.py 2>/dev/null | tail -1 > /tmp/stashwise-e2e-token.txt
TOKEN="$(cat /tmp/stashwise-e2e-token.txt)"
if [ -z "$TOKEN" ]; then echo "Seeding failed."; exit 1; fi
echo "    token: ${TOKEN:0:12}..."

echo "==> Starting the backend on 127.0.0.1:$PORT"
cleanup
DATABASE_URL="sqlite+aiosqlite:///$DB" nohup uv run uvicorn app.main:app \
  --host 127.0.0.1 --port "$PORT" > "$LOG" 2>&1 &

for i in $(seq 1 45); do
  if curl -fsS -m 2 -o /dev/null -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:$PORT/api/v1/auth/me" 2>/dev/null; then
    echo "    up after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" -eq 45 ]; then
    echo "Backend did not come up. Last 20 lines of $LOG:"
    tail -20 "$LOG"
    exit 1
  fi
done

echo "==> Running the sync end-to-end"
rm -rf "$VAULT" && mkdir -p "$VAULT"
cd "$PLUGIN_DIR"
E2E_API_URL="http://127.0.0.1:$PORT/api/v1" \
E2E_TOKEN="$TOKEN" \
E2E_VAULT="$VAULT" \
  node scripts/e2e.mjs

echo
echo "==> Vault written to $VAULT"
find "$VAULT/Stashwise" -type f | sort | sed 's/^/    /'
