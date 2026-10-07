# Architecture

One local companion connects Codex to Figma's native Plugin API. The workbench observes that environment; it does not maintain another editable document model.

| Boundary                                            | Owns                                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `src/native-runtime.js`, `src/script-runtime.js`    | Native execution, event observation and receipt delivery       |
| `src/design-queries.js`                             | Read-only design queries and export through the Plugin API     |
| `scripts/execution.cjs`                             | Scheduling, operation transitions and the SQLite ledger        |
| `scripts/bridge-server.cjs`                         | Authenticated loopback transport and live native clients       |
| `scripts/mcp.cjs`                                   | MCP tools, validation and adaptation of the shared environment |
| `scripts/catalog*.cjs`, `src/account-reader.js`     | Account discovery, coverage and verified cloud-file bindings   |
| `src/app-ui.js`, `src/canvas-view.js`               | File workbench and native raster preview                       |
| `scripts/installation.cjs`, `scripts/state.cjs`     | Private storage and atomic activation of one current package   |
| `scripts/updates.cjs`, `scripts/update-service.cjs` | Signed release reception and per-user update lifecycle         |
| `scripts/codex-refresh.cjs`                         | Official host installation of current metadata and skills      |

## Execution facts

An exact client/file target is required. Ambiguous windows are never selected by title. Cloud bindings require the verified native file URL; account discovery cannot grant native access.

Each edit carries a stable operation ID and request hash. Pending input lives in memory. SQLite owns operation states and receipts, with WAL and FULL synchronous commits; receipt delivery and terminal state commit together. Duplicate requests return the existing result rather than executing again. A lost connection or restart does not turn uncertainty into success or trigger replay. Inspect and reconcile uncertain outcomes before another edit.

Reads and edits use the same scheduler. Figma's native events and completed writes invalidate preview freshness. The sidebar keeps the last image and viewport while a fresh whole-page PNG is exported, avoiding competing reads during an edit. Pan and zoom never claim native node selection.

## Separate adapters

The account-directory adapter reads the current authenticated Figma browser. This private browser implementation can change independently of the native Plugin API. Incomplete coverage is explicit; missing discovery does not disable connected files. File metadata and timestamps come from Figma rather than local approximations.

Host theme variables drive the interfaces. Inline icons are licensed Lucide geometry, without a runtime icon dependency. Small shared CSS supplies neutral states and responsive sizing. The host owns conversation input; the plugin supplies factual file/client/page context through MCP Apps.

## Source and distribution

Edit `src/`, `scripts/` and the skills. The build composes the native runtime and bundles the official MCP Apps SDK; generated files exist only in ignored `build/plugin/`. `package.json` is the sole public runtime file allowlist. No private browser state, host bundles or development records belong in a release.

One package version identifies immutable release contents. The launcher validates an installed receipt, stages changes atomically and preserves private state. It has no historical runtime archive, former-format importer or alternate operation store.

The publisher signs each release descriptor with Ed25519; clients trust the packaged public key and verify exact archive contents before execution. The per-user receiver waits for the companion's atomic maintenance admission, preventing a new operation from crossing activation. A successful startup probe commits the staged package; rollback and a small recovery journal handle failure or process interruption. The canonical source for host refresh is that verified current package. Temporary staging is owned and removed after activation or recovery.

One private `updates/status.json` owns scheduling, HTTP validators, the signed feed and any rejected release. The receiver re-verifies cached signatures before accepting HTTP 304 and revalidates staged releases while waiting for idle. Hourly checks have jitter; startup wakes coalesce, and both host and network failures preserve backoff across restarts. Shutdown cancels network work but lets an in-progress atomic activation finish. GitHub serves static release assets; it is not a push relay. This follows [HTTP conditional request and retry semantics](https://www.rfc-editor.org/rfc/rfc9110.html) and [jittered periodic work](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/), without adding a desktop-app updater framework to the MCP runtime.

Native build identity hashes its actual source. Package-only changes do not rewrite the native entrypoints or restart a connected Figma instance. MCP transports announce the new tool/resource lists; the workbench replaces its HTML through the official MCP Apps resource API and transfers navigation in memory, disposing old observers and pending callbacks. No design state is copied into this handoff.

Run `npm test` and `npm run check` before a release. Pure tests do not establish Desktop behavior: changes to native execution or host integration also need bounded acceptance in the actual editor and packaged runtime. Keep private design evidence outside the source tree.
