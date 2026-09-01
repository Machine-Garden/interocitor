#!/usr/bin/env bash
#
# Run a real Core <-> Swift encrypted-WebDAV interoperability flow.
#
# This is intentionally separate from run-integration-tests.sh: it builds the
# Node core package, creates a mesh with it, and drives Core and Swift as
# separate processes around the same disposable loopback WebDAV server.
#
# Usage:
#   cd packages/interocitor-swift
#   bash Scripts/run-core-swift-interop.sh
#
# Options:
#   WEBDAV_PORT                    Loopback server port (default: 4175)
#   INTEROCITOR_INTEROP_PASSPHRASE Overrides the deterministic test vector

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_DIR="$(cd "$PACKAGE_DIR/../.." && pwd)"
WEBDAV_SERVER="$MONOREPO_DIR/tools/webdav-server/server.mjs"
CORE_PHASES="$SCRIPT_DIR/core-swift-interop.mjs"
PORT="${WEBDAV_PORT:-4175}"
SERVER_PID=""

# This is a public cryptographic test vector for bytes 00..1f. It is never a
# production credential; callers may override it to diagnose a specific key.
export INTEROCITOR_INTEROP_PASSPHRASE="${INTEROCITOR_INTEROP_PASSPHRASE:-1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE}"
RUN_TOKEN="$(date +%s)-${RANDOM}-$$"
export INTEROCITOR_INTEROP_REMOTE_PATH="${INTEROCITOR_INTEROP_REMOTE_PATH:-/core-swift-interop-$RUN_TOKEN}"
export INTEROCITOR_INTEROP_DB_NAME="${INTEROCITOR_INTEROP_DB_NAME:-core-swift-interop-$RUN_TOKEN}"
export INTEROCITOR_INTEROP_SWIFT_REMOTE_PATH="${INTEROCITOR_INTEROP_SWIFT_REMOTE_PATH:-/swift-core-interop-$RUN_TOKEN}"
export INTEROCITOR_INTEROP_SWIFT_DB_NAME="${INTEROCITOR_INTEROP_SWIFT_DB_NAME:-swift-core-interop-$RUN_TOKEN}"

cleanup() {
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

for command in node curl swift yarn; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "Missing required command: $command" >&2
        exit 1
    fi
done

if curl -sS --connect-timeout 0.2 --max-time 0.5 \
    -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo "Port $PORT already serves HTTP; refusing to reuse a server this script does not own" >&2
    exit 1
fi

PORT="$PORT" node "$WEBDAV_SERVER" --mode=memory &
SERVER_PID=$!

for _ in {1..50}; do
    if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        wait "$SERVER_PID" 2>/dev/null || true
        echo "WebDAV server process exited before becoming ready on port $PORT" >&2
        exit 1
    fi
    sleep 0.1
done

if ! kill -0 "$SERVER_PID" 2>/dev/null || \
    ! curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "WebDAV server failed to start on port $PORT" >&2
    exit 1
fi

export INTEROCITOR_WEBDAV_URL="http://127.0.0.1:$PORT"

cd "$MONOREPO_DIR"
env -u YARN_NO_PROXY -u NPM_CONFIG_NOPROXY -u npm_config_noproxy yarn workspace @interocitor/core build
node "$CORE_PHASES" bootstrap

cd "$PACKAGE_DIR"
swift test --no-parallel --filter CoreSwiftInteropIntegrationTests/test_coreCreatedEncryptedMesh_canBeReadAndWrittenBySwift

cd "$MONOREPO_DIR"
node "$CORE_PHASES" verify
node "$CORE_PHASES" compact

cd "$PACKAGE_DIR"
swift test --no-parallel --filter CoreSwiftInteropIntegrationTests/test_coreCompactedSnapshot_canBeRehydratedBySwift

# Reverse direction: Core validates Swift bootstrap and makes an epoch-1
# snapshot. A fresh Swift client observes it and makes an epoch-2 snapshot; a
# new Core client must validate both metadata and encrypted snapshot rows.
swift test --no-parallel --filter CoreSwiftInteropIntegrationTests/test_swiftBootstrappedEncryptedMesh_canBeReadByCore

cd "$MONOREPO_DIR"
node "$CORE_PHASES" verify-swift-bootstrap

cd "$PACKAGE_DIR"
swift test --no-parallel --filter CoreSwiftInteropIntegrationTests/test_swiftBootstrappedMesh_canBeCompactedForCore

cd "$MONOREPO_DIR"
node "$CORE_PHASES" verify-swift-compacted
