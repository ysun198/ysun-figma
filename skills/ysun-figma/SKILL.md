---
name: ysun-figma
description: Read, edit and export Figma through ysun figma. Discover native APIs for layout, grids, vectors, text, components, variables, motion, FigJam, Slides and code handoff; research public Community references without GUI automation.
---

# ysun figma

Use local MCP tools and Figma Desktop's native Plugin API. Normal design work needs no mouse/keyboard automation. Stay in the current conversation. Local operations have no monthly plugin quota or REST-token requirement; Figma permissions, plan gates and service limits still apply. These skills explain mechanics, without prescribing a palette, font, spacing scale, motion style or library architecture.

Keep the ordinary path entirely in MCP: identify, read, write, read back and export. For a loading file or URL verification, use `figma_file(action="status", fileKey=...)` before considering GUI; it observes actual Desktop URLs and renderer load state without navigation, pairing or a native edit. Loading HTML is not a ready editor, a connected plugin or proof of cloud save. Reserve GUI for a specific lifecycle step that has no API route, or a requested real interactive test.

Keep setup proportional to the requested task. Native canvas work needs no REST token. For cloud authoring, reuse the host's existing official Figma connection; if absent, use the host's Figma connection flow. Do not create a second OAuth app, deploy an authorization backend or ask for credential JSON as ordinary onboarding. Direct REST, organization services and Embed API are optional, separately authorized capabilities; the hosted connection does not expose a general REST token. Read [cloud APIs](references/cloud.md) before adding a connection.

Read `figma_status` and target the exact connected file/client. Never bind by title or copied document identity, or choose the first ambiguous instance. Preserve unrelated content and the active page/selection/viewport unless the task changes them. Use the [files workflow](../ysun-figma-files/SKILL.md) for installation, file creation, connection, verified URL binding, account sync and recovery.

For first installation, missing local tools or setup repair, use [setup](../ysun-figma-setup/SKILL.md) before attempting native work. Setup verifies the intended file with a real read; it does not require an optional cloud grant or a manual pairing code.

## Discover before implementing

`figma_api()` lists intent-based workflows and native topics; `figma_api(workflow="edit")` returns when to use its tools and the guide text; `figma_api(query="文字沿路径排版")` routes a task to symbols, guides and exact declarations; `figma_api(topic="vectors")` reads a recipe. A literal miss returns native topics for another approach, not a claim of missing support. Translate the user's desired behavior into native concepts without asking them to name a Figma feature. Discovery works offline from the single [feature index](references/api-map.md). `figma_capabilities` checks live callable methods; resource enumeration needs `includeResources=true`. Presence does not establish editor/account entitlement. For important edits use the [files workflow](../ysun-figma-files/SKILL.md) for a native version checkpoint, rather than routinely exporting .fig files.

A task miss is not proof that Figma lacks the feature: translate it to native concepts, inspect the relevant type/topic, then consult the linked official Plugin API documentation when the pinned reference is insufficient. `figma_api(query="figma_design_context")` returns the current installed MCP tool contract and version; use it to resolve parameter errors or stale host metadata instead of guessing another parameter. Do not invent a method or copy a hosted-only helper into native code.

Before `figma_run`, read [native execution](references/native-execution.md). It accepts trusted async JavaScript bodies with the real Plugin API and documented bridge helpers. Remote node.query/node.set/node.screenshot conveniences and automatic page resets are absent; native operations serialize per file. For concurrent tasks, reuse one exact native client per file and pin each workspace by root ID. Prefer a coherent native read/compute/write when the decision can use live values in one body. When a decision depends on an earlier tool read, use `figma_snapshot` and pass its job.id through `ifUnchanged`; follow [conditional edits](references/concurrency.md). Changed observed fields reject before the body executes; re-read and merge. Roots/readOnly are not sandboxes; asynchronous bodies are not transactions.

| Task                                                         | Workflow                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| Editable screens, including source code → Figma              | [create-design](../ysun-figma-create-design/SKILL.md)                 |
| Variables, styles, components and variants                   | [design-system](../ysun-figma-design-system/SKILL.md)                 |
| Navigation, overlays and state interactions                  | [prototype](../ysun-figma-prototype/SKILL.md)                         |
| Boards and editable diagrams                                 | [FigJam](../ysun-figma-figjam/SKILL.md)                               |
| Decks, rows and slide grids                                  | [Slides](../ysun-figma-slides/SKILL.md)                               |
| Native keyframes, animation styles and motion implementation | [motion](../ysun-figma-motion/SKILL.md)                               |
| Figma → repository code, including SwiftUI                   | [design-to-code](../ysun-figma-design-to-code/SKILL.md)               |
| Local component-to-code mappings                             | [Code Connect](../ysun-figma-code-connect/SKILL.md)                   |
| Native shader application                                    | [shaders](references/shaders.md)                                      |
| Public template/reference research                           | `figma_community`; read [Community research](references/community.md) |
| Specs, Make and other hosted workflows                       | [capability boundaries](references/capabilities.md)                   |

## Execute and verify

Use `figma_inspect` for IDs, bounds and parents; `figma_find_nodes` for lightweight searches without resolving instance masters; `figma_design_context` for detailed layout/assets/bindings; `figma_design_system` for file assets and enabled variable libraries; `figma_download_assets` for original bytes; `figma_motion` for real tracks. `includeComponentMetadata=true` retains detailed component information in a search when needed. Paginated searches need the same target/options; edits expire cursors. Sparse, truncated or failed reads do not establish absence.

Keep one stable operationId per intentional edit/import. Preflight errors submit no native work. For interrupted or accepted work, read the original `figma_job`; inspect exact affected IDs and reconcile uncertain/partial outcomes before another edit. Never replay an uncertain write with a new ID. Return affected IDs and useful structural evidence, then obtain a native export when appearance matters. Repeat checks after a relevant change or missing evidence.

Use `figma_navigate` for native page/selection/viewport changes. Static verification uses native screenshots/exports. A JSON_REST_V1 export is not a .fig backup; a static render or stored reaction does not prove focus, dragging, presenter input or other real interactions. Cloud-only services need their own integration, not an invented native substitute.

## Workbench and lifecycle

Use `figma_file(action="sync")` to refresh and list account files in the ordinary tool result. Use the exact returned fileKey with `figma_file(action="open", fileKey)` to open and connect the actual editor through Desktop's native launcher. `action="connect"` recovers an already open exact file, reuses saved authorization, pairs an owned new native frame when needed and binds its observed URL/document/instance without GUI. It preserves permission checks, other active plugins and unresolved operations. Native sessions separately report Desktop page and selection. Use `figma_screenshot` for a bounded native image when visual inspection is needed; `figma_file(action="launch", fileKey)` brings the exact Desktop file forward when requested.

Use [native profiles](references/native-profiles.md) for a real Widget runtime, Dev Mode/codegen/text review or Buzz. Widget render preparation and exact-node reconnect are direct MCP actions with the existing ledger.

Use the host's official Figma tools for supported cloud authoring. Use `figma_rest` only when the task needs a direct REST endpoint or separate SCIM/Discovery service and its credential profile. The package declares the official hosted Figma MCP and registered Figma connector; read [cloud APIs](references/cloud.md) for connection selection. Ordinary native canvas work stays local.

Published updates retain grants and receipts. `figma_status.skillRootPath` and `apiReferencePath` locate the stable current installation if a host cache disappears. An unchanged nativeBuild needs no native restart. A matching runtime version does not override a different build. Use the files workflow to reconnect an outdated build after its operations settle; no manual reopening or code entry is needed on the supported Desktop path. After profile changes, use the returned client/instance and renew binding from the actual open-file URL.

A closed/stale host transport or a missing new tool in the host's older catalog can use the same companion's existing callTool export as described in [native execution](references/native-execution.md), with the same grants and ledger. Do not silently omit a required condition because the host lacks its tool name. This does not prove host UI acceptance. Reserve GUI for a concrete uncovered lifecycle step or a requested real interactive test.
