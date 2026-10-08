---
name: ysun-figma
description: Read, edit and export Figma through ysun figma with automatic local connection and recovery. Route file, design, prototype, FigJam, Slides, design-system, motion and design-to-code tasks to the corresponding native workflow.
---

# ysun figma

Use this plugin's local tools and Figma Desktop's native Plugin API. No paid MCP tier or REST token is required. Local operations have no monthly plugin quota; Figma permissions, plan-specific features and transfer/service limits still apply.

For an ordinary command/design task, stay in the current Codex conversation; show the resulting editable design in Figma Desktop. Use `figma_open` only when the user requests the interface/design browser. The sidebar opens the same workbench and supplies exact file context through the host's existing composer; do not create another chat UI.

Read `figma_status`, reuse the exact connected client and saved authorization. When the file is known, filter by its exact fileKey/clientId. Default job details cover connected files; global counts retain disconnected history. Use scope=all only to investigate that history, and figma_job for the original receipt. Use [files](../ysun-figma-files/SKILL.md) for new/existing file opening, native connection, verified binding, account sync or recovery. Handle routine installation and native automation yourself; expose only a concrete remaining login, permission or automation blocker. Never bind by title or copied document identity.

The workbench uses the exact native connection to render a whole page through Figma's public exportAsync. It needs Desktop and the native plugin, but no second website login. Sidebar fileKey/clientId/pageId are the user's current navigation target, including while its image loads. When the user refers to this project/page, use that exact target; sessions separately describe Desktop's active page/selection. preview.clientId/pageId/revision identify the image actually displayed. A panned raster never selects native layers. Native revisions and write receipts update the image automatically; do not reopen the workbench or issue screenshot tools just to refresh it. Layer editing and prototype playback remain in Desktop. The desktop button targets the current exact fileKey through `figma_file(action="launch")`; clicking an unconnected account card opens that exact Desktop file, then the files workflow establishes its connection. Account discovery reuses Desktop's existing authenticated Home session through a private pipe. No separate browser, copied cookies or Keychain password is required. Use the files workflow if a normally launched Desktop needs safe reconnection.

Before writing a script, read [native execution](references/native-execution.md), then search the relevant native interfaces. `figma_status.apiReferencePath` and `skillRootPath` point to the single stable current installation when an old host cache path disappears. There are no official remote node.query/node.set/node.screenshot/figma.createAutoLayout conveniences locally. Scripts are trusted native API bodies, not a transactional or read-only sandbox.

Use a stable operationId per intended edit/import. Preflight errors submit no native job; correct their stated cause. For queued/running or interrupted execution, read the original `figma_job`. Errors after execution retain logs and completed exports but may have changed the file. Inspect exact affected nodes before `figma_reconcile`, including partially_applied; never replay an uncertain write with a new ID. Preserve unrelated nodes, active page, selection and viewport unless requested.

Use `figma_inspect(nodeId/nodeIds)` for lightweight names, native dimensions and parents; pageId reads another page's roots without activating it. Use `figma_design_context` when layout, property references, vector paths or screenshots are actually needed, `figma_design_system` for file assets/enabled variable libraries, `figma_download_assets` for original bytes and `figma_motion` for actual tracks. File-wide component/node searches use scope=file and their returned continuation cursor with unchanged options; edits expire cursors. Sparse/truncated/error results require narrower reads, not claims of absence.

Load the workflow relevant to the task:

- File creation, connection and recovery: [files](../ysun-figma-files/SKILL.md).
- Editable Design screens, including code → Figma: [create-design](../ysun-figma-create-design/SKILL.md).
- Native navigation, overlays and interactive prototypes: [prototype](../ysun-figma-prototype/SKILL.md).
- Boards and editable diagrams: [FigJam](../ysun-figma-figjam/SKILL.md).
- Decks and slide grids: [Slides](../ysun-figma-slides/SKILL.md).
- Variables, styles, components, variants and repository mappings: [design-system](../ysun-figma-design-system/SKILL.md).
- Figma → actual repository code, including SwiftUI: [design-to-code](../ysun-figma-design-to-code/SKILL.md).
- Native keyframes, video exports or motion implementation: [motion](../ysun-figma-motion/SKILL.md).
- Available native shader fills: [shader reference](references/shaders.md).

Check `figma_capabilities` and actual feature responses for the live editor. Cloud Weave, Make resources, shader/generative-plugin authoring and hosted Code Connect are distinct services; a local script does not implement them. New cloud files require normal authenticated Figma UI creation.

Published updates arrive automatically through the local receiver; figma_status.updates reports its actual state. Retain grants and receipts. Enable Figma's Development → Hot reload plugin once during installation using available native automation. An unchanged nativeBuild needs no restart when the package version changes. If needsPluginUpdate, wait until idle, reopen the native plugin yourself and verify restored authorization. After an actual native restart, renew the exact cloud binding from the open file URL; do not reuse a previous instance's binding. Figma can cache manifest permissions/editor types; re-import the same stable manifest/ID if actual API errors require it. teamlibrary permission does not enable libraries or expand account access.

A closed host transport can continue native tasks through the current companion's existing callTool export, described in [native execution](references/native-execution.md). This uses the same grants/ledger; it cannot prove or repair host sidebar rendering. Raise the actual target Figma window for native GUI acceptance. Do not substitute protocol tests or static previews for the requested real user journey.
