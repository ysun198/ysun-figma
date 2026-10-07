# Installation

Give Codex the release ZIP and ask it to install and connect. These details are for agents and maintainers.

Extract the ZIP to a stable directory and verify its supplied `SHA256SUMS`. Register that directory as a local marketplace and enable the plugin:

```sh
codex plugin marketplace add /absolute/extracted/directory --json
codex plugin add figma-plugin-local@figma-local --json
```

Preserve unrelated plugins and configuration. If this marketplace was registered at a different path, remove only its old registration with `codex plugin marketplace remove figma-local --json` before registering the new path.

Call `figma_connect`. With native app automation, import the returned stable manifest in Figma Desktop if missing, run **ysun figma → Connect**, and enter the one-time code. Enable Figma's **Plugins → Development → Hot reload plugin** for this imported plugin. Verify the exact file and client with `figma_status`. Reuse a working authorization; reopened plugins restore it automatically. Cloud-file bindings require the actual open file URL, never a matching title.

The native Plugin API requires an open file and running plugin; it has no headless installation or account-wide editing endpoint. Figma Desktop must be authenticated. Account discovery additionally needs authenticated ego-browser. When automation is unavailable, report the specific remaining action.

## Updates

The installed launcher registers the per-user macOS LaunchAgent `com.ysun.figma.updates`. It checks this repository's latest published release every five minutes, including while Codex is closed. Installation requires network access once; offline operation continues with the last verified code. Disabling or uninstalling this plugin stops the receiver when it next checks the host.

The receiver verifies an Ed25519-signed release descriptor, archive hash and exact public file allowlist. It waits for queued/running operations, stages one current package, probes the new companion and rolls back on failure. Private authorization, receipts, catalog and exports are preserved. Normal concurrent starts only verify files. Host metadata and skills refresh through the official `codex plugin add` command; active transports notify capability changes and open workbenches load the current UI through the MCP Apps resource bridge.

Native build identity follows code content, independently of the package version. A UI or skill update leaves an unchanged native kernel running. An actual kernel change restarts through [Figma's hot reloading](https://developers.figma.com/docs/plugins/plugin-quickstart-guide/#hot-reloading), restoring saved authorization. A new native instance must renew its cloud binding from the actual open file URL; agents perform that verification rather than carrying an unverified identity across instances. Re-import the stable manifest only when permissions or editor types actually changed.

Versions before 0.24.0 need one installation of a current release to gain the receiver. A source push alone does not update users. Maintainers choose publication with the **Publish release** workflow; uploads are drafts until all signed assets are ready. [OpenAI's local-plugin guide](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually) documents the official host installation command.
