#!/usr/bin/env bash
# run-integration-tests.sh
#
# Starts the repository WebDAV test server, runs `swift test` with WebDAV
# integration tests enabled, then tears the server down.
#
# Usage:
#   cd packages/interocitor-swift
#   bash Scripts/run-integration-tests.sh
#
# Options (env vars):
#   WEBDAV_PORT      Port for the WebDAV server (default: 4174)
#   SWIFT_TEST_FILTER  Passed to `swift test --filter` (default: run all)
#   SKIP_WEBDAV      Set to 1 to skip server startup (unit tests only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_DIR="$(cd "$PACKAGE_DIR/../.." && pwd)"
SERVER_MJS="$MONOREPO_DIR/packages/webdav/server.mjs"
PORT="${WEBDAV_PORT:-4174}"
SERVER_PID=""

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log()  { echo -e "${GREEN}▶${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
fail() { echo -e "${RED}✗${NC}  $*"; exit 1; }

# ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup() {
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        log "Stopping WebDAV server (PID $SERVER_PID)..."
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# ── Start WebDAV server ───────────────────────────────────────────────────────
start_webdav_server() {
    if [[ ! -f "$SERVER_MJS" ]]; then
        warn "WebDAV server not found at $SERVER_MJS"
        warn "Skipping WebDAV integration tests (set SKIP_WEBDAV=1 to suppress this warning)"
        return 1
    fi

    if ! command -v node &>/dev/null; then
        warn "Node.js not found - skipping WebDAV integration tests"
        return 1
    fi

    log "Starting the Interocitor WebDAV test server on port $PORT..."
    PORT="$PORT" node "$SERVER_MJS" --mode=memory &
    SERVER_PID=$!

    # Wait up to 5 s for the server to be ready
    local attempts=0
    until curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; do
        if (( attempts++ >= 50 )); then
            fail "WebDAV server failed to start within 5 s"
        fi
        sleep 0.1
    done
    log "WebDAV server ready at http://127.0.0.1:$PORT"
    return 0
}

# ── Main ──────────────────────────────────────────────────────────────────────
cd "$PACKAGE_DIR"

WEBDAV_AVAILABLE=0
if [[ "${SKIP_WEBDAV:-0}" != "1" ]]; then
    if start_webdav_server; then
        WEBDAV_AVAILABLE=1
        export INTEROCITOR_WEBDAV_URL="http://127.0.0.1:$PORT"
    fi
fi

if [[ $WEBDAV_AVAILABLE -eq 1 ]]; then
    log "WebDAV integration tests ENABLED (INTEROCITOR_WEBDAV_URL=$INTEROCITOR_WEBDAV_URL)"
else
    warn "WebDAV integration tests will be SKIPPED (server unavailable)"
fi

log "Building package..."
swift build

log "Running swift test (serial)..."
if [[ -n "${SWIFT_TEST_FILTER:-}" ]]; then
    swift test --no-parallel --filter "$SWIFT_TEST_FILTER"
else
    swift test --no-parallel
fi

log "All tests completed ✓"
