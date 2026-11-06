---
name: ysun-figma-files
description: Create, open, connect or recover an exact Figma Design, FigJam or Slides file with ysun figma, including account directory refresh and newly created files missing from that directory.
---

# Files and connection

Use [ysun-figma](../ysun-figma/SKILL.md) for the shared tool/runtime contract. Handle installation, native launch, binding and recovery yourself. Keep an ordinary design task in its current Codex conversation.

For a first installation or missing Node/Desktop, use [setup](../ysun-figma-setup/SKILL.md). `figma_connect()` prepares the stable manifest; ordinary connection and pairing use `figma_file` directly. Request `manualPairing=true` only for a diagnosed unavailable Desktop lifecycle.

## Open or create

Prefer the requested file. Read `figma_status`, retain its current clients/instance IDs, and call `figma_file(action="open", fileKey=...)` using the exact key from Figma's actual URL. A newly created file need not wait for account sync or already exist in the directory. `verifiedUrl` can carry its observed Design, board or Slides URL. `launch` brings Desktop forward without pairing.

For a connected file, navigate pages and native selection with `figma_navigate(pageId, nodeIds?, zoomToFit?)`. It activates the real page through `setCurrentPageAsync` and reports selection/viewport without bringing the application forward. Prefer this to clicking page tabs or searching layers in the GUI. Queries can read explicit pages without activating them; navigate only when the task benefits from it. Keep routine inspection, edits, exports and recovery in MCP.

One cloud file can have several native instances. Directory `sessions` and an ambiguous-target error expose the actual candidates; `clientId=null` means no unique instance, not necessarily disconnected. Compare the intended URL/document/instance and pass its exact `clientId`. The plugin does not pick the first instance. Native sessions report the actual Desktop page and selection.

`figma_file(action="status", fileKey=...)` reads open Desktop file URLs and editor load state directly, without GUI, navigation, account sync or pairing. Omit fileKey to inspect up to 20 open file renderers; duplicates remain separate and `complete=false`/`issues` disclose failed or bounded reads. `editorLoaded=null` means unknown. This lifecycle observation does not associate an unbound native client with a renderer, start a plugin, grant access or prove synchronization. Use its actual URL as evidence alongside the exact native instance; do not infer readiness from `documentReady="complete"` alone. Do not open menus or repeatedly take screenshots to diagnose a loading file.

The public native Plugin API operates inside an existing file; it cannot create a cloud file. For a new file, an already authorized official Figma cloud creator can prepare the requested editor without GUI when available; otherwise use normal authenticated Figma Home creation. Record the actual returned URL/key, then use the same local open/connection path. Identify cloud creation as a separate service, without making it a dependency of ordinary local reads/writes. Do not create a second file to evade login/permissions.

Use `figma_file(action="connect",fileKey)` for an already open file, or `action="open"` to open and connect it. The adapter verifies the real renderer URL, invokes the current app's own plugin launcher and permission guard, finds only the owned native frame, restores saved authorization or pairs that frame, and binds the actual document/instance. An active unrelated plugin or unresolved operation is preserved. Duplicate Desktop instances require an exact `targetId` from status. This path needs no menu clicks or text entry. Import the stable manifest only if it is genuinely absent; manual **ysun figma → Connect** is a fallback for a diagnosed unsupported Desktop lifecycle, not the ordinary path.

For Dev/Widget connections, pass `profile="dev"` or `profile="widget"`; see [native profiles](../ysun-figma/references/native-profiles.md). Widget connection requires a stable operationId because it can insert a node. Reuse an exact existing `widgetNodeId` when reconnecting. `action="prepare", profile="widget", sourcePath=absolutePath` installs trusted local render code without executing it on the host; ordinary reconnect retains synced state. Preparing Widget leaves unchanged Dev profile files untouched.

Before `figma_file(action="bind", fileKey, clientId, documentId, verifiedUrl)`, verify that the actual foreground file URL and live instance are the intended target. Use only declared arguments; instanceId is checked by the server, not passed as a bind argument. Error messages distinguish URL, document and client failures. Titles and copied document plugin data do not prove cloud identity. Reopening creates a fresh native instance and requires renewed exact binding when native fileKey is absent.

The job target records the actual file key, document/instance, editor and native versions at submission; use it to compare launch, write and visible file identities. `fileKeyVerified` reports whether this request constrained the target by fileKey/URL; false on a clientId-only call does not imply the catalog binding disappeared. Pass both the known fileKey and clientId when verifying that constraint matters. `editorType=figma` names the Design editor, not proof of Desktop versus browser. The public API does not identify that surface or confirm cloud save completion. Use the actual application URL/sync warning when these distinctions matter; do not declare native edits cloud-synced from a successful receipt.

After Dev/Widget profile switches, use the returned client and instance again: Figma can replace the previous native iframe, and that old instance is immediately retired. Reconnecting an existing Widget retains its exact node ID. Accepted operations keep their original target; never resubmit them against the new instance to recover a receipt.

## Directory and recovery

If `desktop_required`, install the current stable desktop app from [Figma Downloads](https://www.figma.com/downloads/), verify its vendor code signature, then use `figma_file(action="launch")`. Use `~/Applications/Figma.app` when a per-user installation is appropriate; no administrator password is needed there. Reuse an existing Desktop login. A user who has never signed in must complete Figma's ordinary sign-in; the plugin cannot create or bypass that authorization. Resume sync and native connection after sign-in, without reinstalling the plugin.

`figma_file(action="sync")` refreshes and returns the account directory in the ordinary tool result. Ready means all traversed Drafts, team/folder, Recents and shared sources reached their actual Figma pagination end. An incomplete directory is not the whole account. Normal background sync is silent and retains existing files while refreshing. File times/covers come from Figma, never local open events.

Directory `catalog.error`, `coverage` and `lastAttemptAt` expose the actual failed refresh and completed sources; retained files are not proof of a complete new refresh. The adapter subscribes to Figma Home's own directory results and paginated arrays, not a public account-wide REST API.

Account discovery reuses Figma Desktop login. If `desktop_restart_required`, preserve the existing files and Desktop profile. Use the version-checkpoint workflow below when appropriate, then quit normally with native app automation and use `figma_file(action="launch")` to restart with its private pipe. If Figma warns about pending changes, let synchronization finish or cancel the quit; do not force it or routinely export .fig files to make discovery work. Restore the exact files and saved native authorizations, verify URLs and renew bindings for new instances. The pipe is established at app startup; a later independent Dock launch may need this reconnection again. If `login_required`, complete ordinary sign-in in Figma Desktop, then sync. Do not read Keychain credentials, copy cookies, install an external browser or ask for a second browser login. Existing native reads/edits remain available while discovery is unavailable.

Use `figma_status.apiReferencePath` for the installed API declaration. Its `skillRootPath` points to the one stable current skill tree; use it if a host cache path disappears during an upgrade. Do not pin an old cache version or reinstall old code. Read unresolved jobs before recovery; never replay an uncertain edit.

## Recovery without routine file exports

Ordinary edits use the existing native Undo boundary. Before a substantial destructive edit or experiment on existing work, create a named version through `figma_run` with a stable operation ID, `commitUndo=false`, and this native body:

```js
const version = await figma.saveVersionHistoryAsync(
  args.title,
  args.description,
);
return { saved: !!version?.id, versionId: version?.id ?? null };
```

Use a nonempty title and keep the returned version ID in the existing receipt/task result. Await the checkpoint before editing. A null result or rejected call is not a saved checkpoint. There is no additional backup database or export format. Avoid creating a version for every small operation.

The [official contract](https://developers.figma.com/docs/plugins/api/properties/figma-saveversionhistoryasync/) warns that immediately preceding plugin edits may be absent from the saved version. This is suitable as a checkpoint of the existing design before changing it; it is not a general save/flush guarantee. A fixed delay does not prove inclusion. For an exact post-edit preservation requirement, verify the relevant stored cloud version with separately available authorized tooling, or report that boundary. Restore through Figma's version history when needed; this package has no public native restore-version method. Do not automate Undo across unrelated user edits.

A cloud version is not independent offline protection. Export a native .fig copy only when offline backup is explicitly needed; retain the existing file if one already exists. JSON_REST_V1 is handoff data, not a round-trip substitute. No GUI is needed to create the version checkpoint.

Use GUI only for an uncovered lifecycle step or requested real interaction, such as first sign-in, initial connection, cloud-file creation, explicit offline .fig saving, version restoration or prototype playback. Native hierarchy/exports establish static results; a protocol test alone does not establish interactive behavior or cloud synchronization.
