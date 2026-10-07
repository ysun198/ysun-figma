---
name: ysun-figma-figjam
description: Create or edit editable FigJam boards and diagrams with ysun figma, using native shapes, sticky notes and connected edges in the actual FigJam editor.
---

# FigJam

Use [files](../ysun-figma-files/SKILL.md) for the destination and [native execution](../ysun-figma/references/native-execution.md) before scripts. Check live editorType/capabilities; Design methods are not automatically FigJam methods. A new board requires normal authenticated Figma UI creation.

Inspect the intended page before writing. Organize it with native sections, sticky notes, shapes and connectors. A sticky/shape's text lives in `.text`; load its actual font with `bridge.loadFonts(node)` before changing `node.text.characters`. New connector text can have an empty font family/style: load a real adjacent/intended font, assign `connector.text.fontName`, then set characters. Preserve existing styled fonts.

Search `ConnectorNode`, `ConnectorEndpoint`, `TextSublayerNode` and `ShapeWithTextNode` in the single API reference. Native STRAIGHT connectors accept CENTER/NONE magnets; use ELBOWED for edge magnets such as LEFT/RIGHT. Read back endpoint IDs, line type and text.

For a diagram, establish the actual graph, layout and edge semantics first, create nodes and return IDs, then wire edges to those IDs. Preserve relationships and identifiers when editing. No Mermaid parser is bundled; translate its real graph rather than claiming arbitrary syntax is automatically converted. Use [design-system](../ysun-figma-design-system/SKILL.md) only if reusable tokens/components are part of the task.

`figma_upload_assets` checks actual constructors and createImage availability. Editable SVG and raster import are native operations; supply the intended parent ID and stable operation ID. Read the returned node and rendered result. Do not manufacture a cloud upload URL.

Verify native hierarchy, shape text, endpoint attachment and an actual board preview. Clean up only exact task-owned IDs. Follow original receipts after interruptions; a static image does not prove connectors or collaborative behavior.
