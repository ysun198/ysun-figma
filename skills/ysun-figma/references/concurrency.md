# Conditional edits and concurrent tasks

Use `figma_api(workflow="edit")` for an existing design. Different files progress independently; the same native client executes one operation at a time. Several Codex tasks may share that client without taking a long-lived task lock. Reuse the same native client for one file. Native windows/devices with separate instances and cloud synchronization are not a distributed transaction.

## Choose the write boundary

For a direct intent such as "increase this frame's width by 8", prefer one native call: resolve the exact root, read its current width inside the body and call `resize` with that value plus 8. Several serialized operations then all apply to live state. Do not send a previously read absolute width or require a cross-call snapshot for a calculation that can stay native. Prepare fonts/assets first and keep the final dependent reads and writes together without intervening awaits where practical.

Use a snapshot when the model's decision depends on a prior tool read, such as choosing a new layout after inspecting the existing content. That decision spans calls and needs a stale-state check. A plain absolute assignment or new construction in one coherent call can omit the snapshot when it does not depend on earlier values. Preserve unrelated current properties rather than resending old whole arrays.

## Read, derive across calls, conditionally write

1. Resolve the exact client and affected IDs. Assign each task an explicit frame/page root, preserving current page, selection and viewport. Do not use `figma.currentPage` as another task's workspace.
2. Call `figma_snapshot` with `rootId` and the resource fields the decision depends on. Read the returned `job.result.value`; keep the original `job.id`. Resource kinds are `node`, `variable`, `collection`, `style`. Fields are native data properties, including dotted paths, not methods. Observe `children` when membership/order matters, `characters` and relevant text formatting for text edits, `fills` for paint edits, `manualKeyframeTracks`/`animationStyles`/`timelines` for animation, and shared variables/styles used by the decision. Avoid observing unrelated fields just to obtain a coarse lock.
3. Submit `figma_run` or `figma_upload_assets` with `ifUnchanged: [snapshotJobId]`. The original successful read receipt supplies the observations; do not reconstruct a token or send modified observed values. Multiple snapshots can cover shared resources. Provide a stable operationId for this intentional edit.
4. Inspect/export the affected nodes. A successful receipt means execution completed; visual and interaction acceptance still require appropriate evidence.

Example tool inputs, after resolving the exact root ID:

```json
{"clientId":"exact-client","rootId":"10:2","resources":[{"kind":"node","id":"10:2","fields":["name","fills"]}]}
```

Then `figma_run`:

```json
{"clientId":"exact-client","operationId":"rename-frame-once","ifUnchanged":["returned-snapshot-job-id"],"source":"bridge.root.name = args.name; return {id: bridge.root.id, name: bridge.root.name};","args":{"name":"Revised"}}
```

The unique snapshot root supplies `bridge.root`; an explicit run `rootId` overrides the creation destination. `bridge.autoLayout` and asset imports default to that root. Raw native creation still needs `bridge.root.appendChild(node)`; raw API calls retain full access. Root/readOnly are conveniences and trusted declarations, not sandboxes.

## What a condition guarantees

The broker resolves original successful snapshot receipts for the exact native instance/file. Immediately before the body, the native executor resolves all resources, compares selected values and node ancestry, then starts the body. Unrelated fields or independent roots do not invalidate each other. Reparenting/deletion rejects stale dependencies. Figma can retain old local variable/collection proxies in ID lookups, so conditions involving those resources use the current native local list for both existence and values. Node-only edits and idle operation do not enumerate variables. There is no per-second lease, task registry, abandoned lock or whole-file revision lock.

`FIGMA_WRITE_CONFLICT` is a known failure: the user body did not run, no Undo entry was committed, and no uncertain-write barrier is created. Read fresh snapshots, preserve newer changes and derive a new intentional edit with a new operationId. Do not use reconcile for this conflict or silently retry the old desired value. `FIGMA_PRECONDITION_FAILED` means a dependency could not be checked; inspect that error and re-read before writing.

This is optimistic concurrency, not rollback or isolation across an asynchronous script body. Complete font/resource preparation before the final mutation where practical; keep edits coherent and return changed IDs. Humans, other plugins and separate native clients can change content while a script awaits. Observe all actual dependencies and do not claim unobserved state is protected. Snapshot receipts use normal retention; an expired receipt requires a fresh read. Repeating an already accepted operationId retrieves its original result, even if the snapshot later expires.

## Cancellation and lost responses

Queued work can be cancelled before it starts. Cancellation/timeout after native execution starts cannot roll back Figma. Read the original `figma_job`, inspect exact affected content and use `figma_reconcile` only for an uncertain/partial outcome. Never rerun an uncertain write under another ID. If native execution succeeded but output delivery failed, reuse its output through `figma_export`; do not repeat the design edit.
