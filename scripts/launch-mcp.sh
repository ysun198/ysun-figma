#!/bin/sh
set -eu
TASK_PLUGIN_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) TASK_RUNTIME="$TASK_PLUGIN_ROOT/runtime/darwin-arm64/node" ;;
  Darwin:x86_64) TASK_RUNTIME="$TASK_PLUGIN_ROOT/runtime/darwin-x64/node" ;;
  *) TASK_RUNTIME="" ;;
esac
if [ ! -x "$TASK_RUNTIME" ]; then
  TASK_RUNTIME="${FIGMA_PLUGIN_STATE_DIR:-$HOME/.canvas-bridge}/runtime/node"
fi
if [ -n "$TASK_RUNTIME" ] && [ -x "$TASK_RUNTIME" ]; then
  export FIGMA_PLUGIN_BUNDLED_NODE="$TASK_RUNTIME"
  exec "$TASK_RUNTIME" "$TASK_PLUGIN_ROOT/src/host/launch-mcp.cjs"
fi
echo 'ysun figma requires the macOS Codex bundle with its included runtime.' >&2
exit 1
