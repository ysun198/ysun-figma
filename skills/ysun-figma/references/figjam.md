# FigJam operations

Confirm `editorType === 'figjam'`. Query `ShapeWithTextNode`, `StickyNode`, `ConnectorNode`, `ConnectorEndpoint`, `TableNode`, `CodeBlockNode` and `SectionNode` before using their editor-specific properties.

Use editable semantic nodes: shapes for entities/steps, connectors for relationships, stickies for notes, tables for tabular data and code blocks for code. Choose the representation required by the user's content; a Mermaid image is not an editable native graph.

```js
if (figma.editorType !== 'figjam') throw new Error('Expected FigJam');
await figma.loadFontAsync(args.font);
const first = figma.createShapeWithText();
first.shapeType = args.shapeType;
first.text.fontName = args.font;
first.text.characters = args.firstLabel;
first.resize(args.width, args.height);
first.x = args.x; first.y = args.y;
const second = first.clone();
second.text.characters = args.secondLabel;
second.x = args.secondX; second.y = args.secondY;
const edge = figma.createConnector();
edge.connectorLineType = args.connectorLineType ?? 'ELBOWED';
// AUTO magnets work with ELBOWED connectors. STRAIGHT connectors only accept CENTER or NONE.
const magnet = edge.connectorLineType === 'STRAIGHT' ? 'CENTER' : 'AUTO';
edge.connectorStart = { endpointNodeId: first.id, magnet };
edge.connectorEnd = { endpointNodeId: second.id, magnet };
return { nodes: [first.id, second.id], connectorId: edge.id };
```

Visible text lives in the `.text` sublayer, not `.name`. For new connector labels, load and assign an actual known face before setting characters; a new text sublayer may not have a usable initial face. For existing labels, `bridge.loadFonts(node)` handles the native sublayer.

Load a new sublayer's actual initial font with `bridge.loadFonts(node)` before replacing its font or characters when that face is usable. A live connector still required its initial `Inter Medium` after assigning a different loaded face; load the exact face named by a native font error and repair that existing connector. Do not recreate the graph after a font failure.

In the current native runtime, a new code block uses `Source Code Pro Medium`; load it with `await figma.loadFontAsync({ family: 'Source Code Pro', style: 'Medium' })` before assigning `.code`. If the runtime reports another required face, load the exact face named by that error before retrying the existing node.

Prefer attached endpoint IDs/magnets when relationships must survive moving a node. A floating `{position:{x,y}}` endpoint deliberately has no attachment. Preserve arrow-cap semantics and existing labels when rerouting an edge. Read `attachedConnectors` to locate dependencies instead of rebuilding the graph.

Plan graph layout from its semantics: flow direction, hierarchy, cycles, branches and lane ownership. Use node dimensions and label lengths to compute positions; do not confuse a board-layout algorithm with a mandatory colour/style template. Sections group related content spatially; a section is not a flowchart step.

Native tables have cell text and row/column APIs. Inspect the exact methods before setting cells; generic scene-node children are not a reliable table model. Preserve merged ranges, headers and existing row order. Keep code blocks editable and use their declared language enum.

`figma_design_context` returns table row/column counts and `table.cells` with coordinates, bounds and native text. Cells share its `maxNodes` budget; truncated tables and unavailable cells remain explicit. Code blocks include `code` and `codeLanguage`. Raster imports use a native frame when this editor has no rectangle constructor; SVG remains editable geometry.

Validate node counts, connector endpoint IDs and labels, then export the relevant board region. Do not copy standalone-plugin examples that call `figma.closePlugin()` or install `figma.ui.onmessage`; the MCP connection owns that lifecycle.
