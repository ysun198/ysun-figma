---
name: ysun-figma-files
description: Create, open, connect or recover an exact Figma Design, FigJam or Slides file with ysun figma, including account directory refresh and newly created files missing from that directory.
---

# Files and connection

Use [ysun-figma](../ysun-figma/SKILL.md) for the shared tool/runtime contract. Handle installation, native launch, binding and recovery yourself. Keep an ordinary design task in its current Codex conversation.

## Open or create

Prefer the requested file. Read `figma_status`, retain its current clients/instance IDs, and call `figma_file(action="open", fileKey=...)` using the exact key from Figma's actual URL. A newly created file need not wait for account sync or already exist in the directory. `verifiedUrl` can carry its observed Design, board or Slides URL. `launch` brings Desktop forward without pairing.

One cloud file can have several native instances. Directory `sessions` and an ambiguous-target error expose the actual candidates; `clientId=null` means no unique instance, not necessarily disconnected. Compare the intended URL/document/instance and pass its exact `clientId`. The plugin does not pick the first instance. Sidebar context is navigation data: fileKey/clientId/pageId identify the user's selected target even before the image loads. Its preview contains the actual rendered client/page/revision; native sessions separately report Desktop page/selection. Panning the raster does not select native layers, and it never sends a user message to request recovery on the agent's behalf.

For a new cloud file, use normal authenticated Figma Home creation and the requested editor. The public native Plugin API operates inside an existing file; it cannot create a cloud file. Record the actual returned URL/key, then use the same local open/connection path. Do not require the official remote MCP or create a second file to evade login/permissions.

Run **ysun figma → Connect** in the intended file. Figma's Actions search/recent plugin entry can be used when menu automation is unreliable; verify the actual result instead of treating a shortcut as proof. Wait for saved authorization to restore, then read status again. Only a genuinely new connection needs `figma_connect(newFile=true)` and its code. Import the returned stable `manifestPath` only if absent or Figma cached outdated manifest permissions/editor support.

Before `figma_file(action="bind", fileKey, clientId, documentId, verifiedUrl)`, verify that the actual foreground file URL and live instance are the intended target. Use only declared arguments; instanceId is checked by the server, not passed as a bind argument. Error messages distinguish URL, document and client failures. Titles and copied document plugin data do not prove cloud identity. Reopening creates a fresh native instance and requires renewed exact binding when native fileKey is absent.

The job target records the actual file key, document/instance, editor and native versions at submission; use it to compare launch, write and visible file identities. `fileKeyVerified` reports whether this request constrained the target by fileKey/URL; false on a clientId-only call does not imply the catalog binding disappeared. Pass both the known fileKey and clientId when verifying that constraint matters. `editorType=figma` names the Design editor, not proof of Desktop versus browser. The public API does not identify that surface or confirm cloud save completion. Use the actual application URL/sync warning when these distinctions matter; do not declare native edits cloud-synced from a successful receipt.

## Directory and recovery

If `desktop_required`, install the current stable desktop app from [Figma Downloads](https://www.figma.com/downloads/), verify its vendor code signature, then use `figma_file(action="launch")`. Use `~/Applications/Figma.app` when a per-user installation is appropriate; no administrator password is needed there. Reuse an existing Desktop login. A user who has never signed in must complete Figma's ordinary sign-in; the plugin cannot create or bypass that authorization. Resume sync and native connection after sign-in, without reinstalling the plugin.

`figma_file(action="sync")` starts one account refresh; use `figma_open` to observe it. Ready means all traversed Drafts, team/folder, Recents and shared sources reached their actual Figma pagination end. An incomplete directory is not the whole account. Normal background sync is silent and retains existing files while refreshing. File times/covers come from Figma, never local open events.

Directory `catalog.error`, `coverage` and `lastAttemptAt` expose the actual failed refresh and completed sources; retained files are not proof of a complete new refresh. The adapter subscribes to Figma Home's own directory results and paginated arrays, not a public account-wide REST API.

Account discovery reuses Figma Desktop login. If `desktop_restart_required`, check for unsynced changes and save local copies where necessary, then quit normally with native app automation and use `figma_file(action="launch")` to restart with its private pipe. Never force quit a document with pending changes. Restore the exact files and saved native authorizations, verify URLs and renew bindings for new instances. The pipe is established at app startup; a later independent Dock launch may need this reconnection again. If `login_required`, complete ordinary sign-in in Figma Desktop, then sync. Do not read Keychain credentials, copy cookies, install an external browser or ask for a second browser login. Existing native reads/edits remain available while discovery is unavailable.

Use `figma_status.apiReferencePath` for the installed API declaration. Its `skillRootPath` points to the one stable current skill tree; use it if a host cache path disappears during an upgrade. Do not pin an old cache version or reinstall old code. Read unresolved jobs before recovery; never replay an uncertain edit.

Raise the actual Figma window for native actions and acceptance. Report only an actual remaining login, permission or automation blocker. A protocol test cannot prove native import, sidebar appearance or interactive prototype behavior.
