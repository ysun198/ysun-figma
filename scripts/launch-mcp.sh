#!/bin/sh
set -eu
TASK_PLUGIN_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec /bin/sh "$TASK_PLUGIN_ROOT/scripts/run-node.sh" "$TASK_PLUGIN_ROOT/src/host/launch-mcp.cjs"
