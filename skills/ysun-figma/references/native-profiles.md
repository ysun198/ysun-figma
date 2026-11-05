# Editor and Widget entrypoints

`figma_file(action="connect", profile="dev", fileKey=...)` uses the separately registered Dev profile. Its manifest enables Design and Dev Mode, `inspect`, `codegen` and `textreview`. The ordinary manifest retains FigJam, Slides and Buzz: Figma forbids combining Dev Mode and FigJam in one manifest. The profiles share the existing companion, transport, operation journal and recovery rules. Existing file names never establish identity. Actual Figma permission checks still run.

Codegen mode registers `figma.codegen.on('generate')` and returns real native CSS or a compact node JSON projection. It does not open the normal connection UI in a generate callback. Inspect/default mode can use the native MCP executor. Codegen preferences, text review callbacks and payment APIs have their own mode and authorization rules; namespace access does not permit checkout or override plan requirements.

## Widgets

Widget APIs require a real `containsWidget: true`, `widgetApi: "1.0.0"` entrypoint. A `figma.widget` object in a classic plugin does not provide `register` or hooks. The package includes a separately registered Widget profile for Design and FigJam, using the same native MCP kernel. It registers one functional widget; a normal Widget effect starts its local connection. Its indefinite task exists only while that native Widget instance is running and closes with the instance.

Use `figma_file(action="connect", profile="widget", fileKey=..., widgetNodeId=exactOwnedId, operationId=stableId)` to reconnect an existing Widget. Inspect the page first and reuse its exact Widget node, never create a duplicate to recover a connection. Without widgetNodeId the action inserts a new Widget through the app's actual guarded insertion path, so a stable operationId is mandatory. Figma defers Widget effects in hidden files, so a cold connection activates only that exact file through its native deep link and verifies renderer visibility before mounting; no menu clicks are needed. It uses the ordinary durable receipts, file queue and uncertain-write barrier. After interruption read that original receipt and inspect the actual page before retrying.

Once connected, target the returned Widget clientId in `figma_run`. This is the actual Widget context: `widgetSyncedState`, `setWidgetSyncedState` and `cloneWidget` retain Figma's widgetId ownership rules. Preserve the full previous state when setting it; other Widget IDs cannot be edited through this profile. The bootstrap exposes `label` and `count` only as a functional connection fixture, not a limitation on the API.

For a persistent custom render, write a trusted local JavaScript module and call `figma_file(action="prepare", profile="widget", sourcePath=absolutePath)`. The module receives `widget` and must return its functional render, for example:

```js
return function StatusWidget() {
  const [label] = widget.useSyncedState('label', 'Ready');
  return widget.h(widget.Text, { fontSize: 18 }, label);
};
```

Hooks, state/maps, effects, menus, primitives and handlers run in Figma's real Widget render lifecycle. Use `figma_api(query="figma.widget.useSyncedMap")` for the pinned official declaration. Preparation checks JavaScript syntax without executing it on the host. The source remains a private local definition and is preserved when the companion updates. It is compiled into the local Widget entrypoint; it is never evaluated from cloud synced state. Changing this local Widget program affects its local instances after restart. Finish/reconcile its operations before preparing; reconnect with `restart=true` and an existing exact Widget ID, then verify state and an export. Do not label a prepared module, type lookup or successful transport as a verified rendered Widget.

## Buzz

The ordinary manifest enables Buzz. Connect its exact `/buzz/` file with the normal file workflow. Prefer `figma.buzz.createFrame` and the native canvas grid, then read back its asset type/text/media content. The grid belongs to `figma.getCanvasGrid()`. Text fields expose `value`, `node` and `setValueAsync`, not enumerable plain properties. Current Figma versions can omit the declared media field `setMediaAsync`; `await bridge.setBuzzMedia(field, imageOrVideoPaint)` uses that setter when present or updates the one matching native fill while preserving unrelated fills. Re-read the exact media hash/node after changes; ambiguous fills fail before mutation. Setting an asset type and smart-resizing are separate actions: resizing can change its reported type to CUSTOM. Design, FigJam and Slides constructors are not interchangeable with Buzz. Never bypass an editor/plan gate by changing its reported editorType.

Native profile manifests live under the private state's `dev/` and `widget/` directories. The primary installation remains `plugin/manifest.json`. Import a missing registered profile once through the app's development entrypoint; saved profile authorization and direct connections handle subsequent work. Keep first registration/import acceptance distinct from ordinary zero-GUI reads and writes.
