#!/bin/sh
# Node is a shared prerequisite, not part of each plugin release. The installer
# can select a host-provided runtime or install official Node without admin rights.
set -eu
if [ -n "${FIGMA_PLUGIN_NODE_ENGINE:-}" ]; then
  # launchd embeds this selector so activation recovery also works while the
  # current package is between its two directory renames.
  TASK_MINIMUM="$FIGMA_PLUGIN_NODE_ENGINE"
  unset FIGMA_PLUGIN_NODE_ENGINE
else
  TASK_PLUGIN_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
  TASK_MINIMUM="$(/usr/bin/plutil -extract engines.node raw -o - "$TASK_PLUGIN_ROOT/package.json")"
fi
case "$TASK_MINIMUM" in
  '>='*) TASK_MINIMUM="${TASK_MINIMUM#>=}" ;;
  *) echo 'Unsupported Node.js engine requirement.' >&2; exit 1 ;;
esac
case "$TASK_MINIMUM" in
  ''|*[!0-9]*) echo 'Invalid Node.js engine requirement.' >&2; exit 1 ;;
esac
for TASK_NODE in "${FIGMA_PLUGIN_NODE:-}" "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node "${FIGMA_PLUGIN_STATE_DIR:-$HOME/.canvas-bridge}/node/bin/node"; do
  if [ -n "$TASK_NODE" ] && [ -x "$TASK_NODE" ] && "$TASK_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= Number(process.argv[1]) ? 0 : 1)' "$TASK_MINIMUM" 2>/dev/null; then
    export FIGMA_PLUGIN_NODE="$TASK_NODE"
    exec "$TASK_NODE" "$@"
  fi
done
echo "ysun figma requires Node.js $TASK_MINIMUM or newer. Ask Codex to reuse an available runtime or install official Node.js for this user; see docs/INSTALL.md." >&2
exit 1
