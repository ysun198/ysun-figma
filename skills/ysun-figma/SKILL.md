---
name: ysun-figma
description: Read, edit and export Figma through ysun figma. Discover native APIs for layout, grids, vectors, text, components, variables, motion, FigJam, Slides and code handoff; research public Community references without GUI automation.
---

# ysun figma

Use local MCP tools and Figma Desktop's native Plugin API. Normal design work needs no mouse/keyboard automation. Stay in the current conversation. Local operations have no monthly plugin quota or REST-token requirement; Figma permissions, plan gates and service limits still apply. These skills explain mechanics, without prescribing a palette, font, spacing scale, motion style or library architecture.

Read `figma_status` and target the exact connected file/client. Never bind by title or copied document identity, or choose the first ambiguous instance. Preserve unrelated content and the active page/selection/viewport unless the task changes them. Use the [files workflow](../ysun-figma-files/SKILL.md) for installation, file creation, connection, verified URL binding, account sync and recovery.

## Discover before implementing

`figma_api()` lists intent-based workflows and native topics; `figma_api(workflow="edit")` returns when to use its tools and the guide text; `figma_api(query="文字沿路径排版")` routes a task to symbols, guides and exact declarations; `figma_api(topic="vectors")` reads a recipe. A literal miss returns native topics for another approach, not a claim of missing support. Translate the user's desired behavior into native concepts without asking them to name a Figma feature. Discovery works offline from the single [feature index](references/api-map.md). `figma_capabilities` checks live callable methods; resource enumeration needs `includeResources=true`. Presence does not establish editor/account entitlement. For important edits use the [files workflow](../ysun-figma-files/SKILL.md) for a native version checkpoint, rather than routinely exporting .fig files.

A task miss is not proof that Figma lacks the feature: translate it to native concepts, inspect the relevant type/topic, then consult the linked official Plugin API documentation when the pinned reference is insufficient. `figma_api(query="figma_design_context")` returns the current installed MCP tool contract and version; use it to resolve parameter errors or stale host metadata instead of guessing another parameter. Do not invent a method or copy a hosted-only helper into native code.

Before `figma_run`, read [native execution](references/native-execution.md). It accepts trusted async JavaScript bodies with the real Plugin API and documented bridge helpers. Remote node.query/node.set/node.screenshot conveniences and automatic page resets are absent; native operations serialize per file. For concurrent tasks, reuse one exact native client per file and pin each workspace by root ID. Prefer a coherent native read/compute/write when the decision can use live values in one body. When a decision depends on an earlier tool read, use `figma_snapshot` and pass its job.id through `ifUnchanged`; follow [conditional edits](references/concurrency.md). Changed observed fields reject before the body executes; re-read and merge. Roots/readOnly are not sandboxes; asynchronous bodies are not transactions.

| Task | Workflow |
| --- | --- |
| Editable screens, including source code → Figma | [create-design](../ysun-figma-create-design/SKILL.md) |
| Variables, styles, components and variants | [design-system](../ysun-figma-design-system/SKILL.md) |
| Navigation, overlays and state interactions | [prototype](../ysun-figma-prototype/SKILL.md) |
| Boards and editable diagrams | [FigJam](../ysun-figma-figjam/SKILL.md) |
| Decks, rows and slide grids | [Slides](../ysun-figma-slides/SKILL.md) |
| Native keyframes, animation styles and motion implementation | [motion](../ysun-figma-motion/SKILL.md) |
| Figma → repository code, including SwiftUI | [design-to-code](../ysun-figma-design-to-code/SKILL.md) |
| Local component-to-code mappings | [Code Connect](../ysun-figma-code-connect/SKILL.md) |
| Native shader application | [shaders](references/shaders.md) |
| Public template/reference research | `figma_community`; read [Community research](references/community.md) |
| Specs, Make and other hosted workflows | [capability boundaries](references/capabilities.md) |

## Execute and verify

Use `figma_inspect` for IDs, bounds and parents; `figma_find_nodes` for lightweight searches without resolving instance masters; `figma_design_context` for detailed layout/assets/bindings; `figma_design_system` for file assets and enabled variable libraries; `figma_download_assets` for original bytes; `figma_motion` for real tracks. `includeComponentMetadata=true` retains detailed component information in a search when needed. Paginated searches need the same target/options; edits expire cursors. Sparse, truncated or failed reads do not establish absence.

Keep one stable operationId per intentional edit/import. Preflight errors submit no native work. For interrupted or accepted work, read the original `figma_job`; inspect exact affected IDs and reconcile uncertain/partial outcomes before another edit. Never replay an uncertain write with a new ID. Return affected IDs and useful structural evidence, then obtain a native export when appearance matters. Repeat checks after a relevant change or missing evidence.

Use `figma_navigate` for native page/selection/viewport changes. Static verification uses native screenshots/exports. A JSON_REST_V1 export is not a .fig backup; a static render or stored reaction does not prove focus, dragging, presenter input or other real interactions. Cloud-only services need their own integration, not an invented native substitute.

## Workbench and lifecycle

Open `figma_open` when the user requests the browser/sidebar. Its fileKey/clientId/pageId are the intended navigation target; native sessions separately report Desktop selection. preview.clientId/pageId/revision identify the rendered image. Panning the raster does not select layers. Native revisions refresh it automatically, so do not reopen the workbench or take extra screenshots merely to refresh. `figma_file(action="launch", fileKey)` shows the exact Desktop file when requested.

Published updates retain grants and receipts. `figma_status.skillRootPath` and `apiReferencePath` locate the stable current installation if a host cache disappears. An unchanged nativeBuild needs no native restart. Use the files workflow for needsPluginUpdate, manifest changes or a new native instance; renew cloud binding from its actual open-file URL.

A closed/stale host transport or a missing new tool in the host's older catalog can use the same companion's existing callTool export as described in [native execution](references/native-execution.md), with the same grants and ledger. Do not silently omit a required condition because the host lacks its tool name. This does not prove host UI acceptance. Reserve GUI for a concrete uncovered lifecycle step or a requested real interactive test.
