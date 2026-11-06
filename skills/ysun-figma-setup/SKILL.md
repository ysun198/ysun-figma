---
name: ysun-figma-setup
description: Set up or repair ysun figma on macOS after installation, including missing Node.js or Figma Desktop, first native registration, exact-file connection and stale native builds. Use for onboarding and connection setup; ordinary design work uses ysun-figma.
---

# Set up ysun figma

Reach one useful native read in the user's intended Figma file. Handle routine installation and connection work yourself, keeping the current conversation. Ordinary canvas work needs no REST token, credential JSON, new OAuth app or server. Enable the host's official Figma connection only when the requested task needs cloud authoring. The package uses the host's ON_USE policy so cloud authorization is deferred beyond installation.

## Before MCP is available

Read [installation](../../docs/INSTALL.md) when installing from the repository URL, a tool process cannot start or a prerequisite is missing. Use the verified prebuilt release and its declared Node.js engine. A source checkout is not the installable package. Preserve other plugins and existing private state; do not clone a second installation or erase grants to repair discovery.

The skills can be read before the local MCP starts. Check Node.js locally first; reuse a compatible runtime or install the official architecture-matched runtime for this user as documented. A missing runtime is an installation step, not a request for the user to install developer tooling or edit MCP JSON. After preparing it, refresh this plugin and retry its tools.

## Connect the intended file

Read [files and recovery](../ysun-figma-files/SKILL.md) for exact identity and safe Desktop restart. Prefer the URL/key already provided by the user. Without a specified target, read `figma_status` and `figma_file(action="status")`: reuse the unique intended open editor when unambiguous. Multiple files remain separate; ask which one only when the task and observed URLs cannot resolve that choice. Directory sync and optional cloud authorization are not prerequisites for opening a known file.

Use `figma_file(action="open", fileKey=...)` for a known file, or `action="connect"` for an already open editor. This invokes the actual guarded launcher, restores saved authorization or pairs the owned frame, and binds its verified identity directly. Use the ordinary profile for normal design work. Prepare Dev/Widget only when the task needs them.

`figma_connect()` returns the stable manifest path and preparation state; it does not open a file, create a cloud file or allocate a pairing code by default. Only a diagnosed unavailable Desktop lifecycle justifies its `manualPairing=true` fallback. Do not start onboarding with menus, connection-code entry or a second OAuth application.

| Observed result                                     | Next action                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop_required`                                  | Install signed Figma Desktop from its official download, then launch through `figma_file`.                                                                  |
| `login_required`                                    | Let the user complete Figma's own sign-in, then resume the same connection.                                                                                 |
| `desktop_restart_required`                          | Inspect pending/save state, quit normally when safe and relaunch through `figma_file`; preserve the login and files.                                        |
| `desktop_plugin_not_imported`                       | Import the one returned stable manifest through available app automation once; retry direct connection. Enable native hot reload for future kernel changes. |
| `needsPluginUpdate=true`                            | Read original pending/uncertain operations, finish or reconcile them, then reconnect the exact file. Runtime version alone does not prove a matching build. |
| `desktop_*_schema_changed` or `desktop_*_ambiguous` | Retain the exact adapter diagnostic and identities. Fix or use a supported lifecycle fallback; do not repeatedly click menus or guess module IDs.           |

Sign-in and permission dialogs can require the account holder; leave only that specific action to the user. Do not ask them to find token files, enter internal IDs or perform routine setup that the available tools can handle.

## Verify and continue

Read the returned `clientId`, file URL/key, document/instance and native build, then use `figma_inspect` on that exact target. Report the actual file and a useful observation. For installation alone, keep verification read-only. Carry out the user's requested edit when one was supplied; do not create sample artwork in an unrelated design merely to prove installation.

Dev/Widget switches can replace the previous iframe. Read the returned identity again; do not send new work to the old client or transfer accepted operations to the new instance. Widget reconnects reuse the actual existing `widgetNodeId` and a stable operation ID.

After a skill/package update, use `figma_status.skillRootPath` and `apiReferencePath` for the current installation. An unchanged kernel build needs no native restart. For an interrupted operation, inspect its original `figma_job(operationId=...)` before another write. Once connected, continue the real task with [ysun-figma](../ysun-figma/SKILL.md).
