# Privacy and access

The plugin has no analytics, advertising, remote relay, account service or bundled API key. The companion listens on IPv4 loopback `127.0.0.1:38491`; another computer cannot connect directly. Figma handles cloud documents under its own service and permissions. MCP hosts may send tool inputs and results to their model service according to their settings.

A five-minute, one-use pairing code authorizes trusted local scripts to execute the native Plugin API in one file. The native credential cannot submit jobs or read another client's data; the MCP adapter has a separate private administrator credential. Grants expire after 90 days without renewal, sessions after eight hours. **Forget authorization** revokes the saved grant.

Figma's local `clientStorage` holds the grant. A random, non-secret identity in document plugin data preserves local identity across reopening; no credential is written to the document. Copied identities and matching titles cannot establish cloud-file bindings. Each live binding requires the verified file URL.

Private code, authorization, operation records, catalog and exports live in `~/.canvas-bridge/`. `FIGMA_PLUGIN_STATE_DIR` selects an isolated absolute directory. Directories use 0700 and private files 0600 on macOS. The companion stores grant hashes; its administrator token rotates on startup.

Operation receipts can contain design data, file/page names, console messages and export metadata. Completed receipt details expire after seven days or the 200-record limit. Compact identities and final states remain to prevent replay; uncertain outcomes remain until inspected and reconciled. Source scripts and arguments are not persisted. Unused input assets expire after 24 hours. Do not delete state with pending or uncertain operations.

The workbench receives tool data through the MCP App bridge, without pairing or administrator credentials. Its page preview uses native PNG exports, not an embedded Figma website. Only view and sort preferences are stored in widget localStorage. The workbench updates factual design context but does not send user messages.

Account discovery uses the authenticated Figma browser without copying session cookies or tokens into the companion or widget. The private catalog contains account/file identifiers, metadata, verified bindings and coverage. Signed thumbnail links are access-bearing metadata. Account switches clear the prior directory; incomplete scans preserve known files and report their coverage honestly.

Release packages exclude private state, credentials, Git history, personal designs and development records. A per-user macOS LaunchAgent checks the public GitHub release feed every five minutes and downloads only publisher-signed updates. Those requests contain no Figma credentials, document data or operation records. Updates replace one current package and preserve private data. Disabling or uninstalling the plugin stops this receiver on its next host check. Its plist lives in `~/Library/LaunchAgents/com.ysun.figma.updates.plist`; update state and errors live in the private `updates/` directory.
