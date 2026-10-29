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
edge.connectorStart = { endpointNodeId: first.id, magnet: 'AUTO' };
edge.connectorEnd = { endpointNodeId: second.id, magnet: 'AUTO' };
edge.connectorLineType = args.connectorLineType;
return { nodes: [first.id, second.id], connectorId: edge.id };
```

Visible text lives in the `.text` sublayer, not `.name`. For new connector labels, load and assign an actual known face before setting characters; a new text sublayer may not have a usable initial face. For existing labels, `bridge.loadFonts(node)` handles the native sublayer.

Prefer attached endpoint IDs/magnets when relationships must survive moving a node. A floating `{position:{x,y}}` endpoint deliberately has no attachment. Preserve arrow-cap semantics and existing labels when rerouting an edge. Read `attachedConnectors` to locate dependencies instead of rebuilding the graph.

Plan graph layout from its semantics: flow direction, hierarchy, cycles, branches and lane ownership. Use node dimensions and label lengths to compute positions; do not confuse a board-layout algorithm with a mandatory colour/style template. Sections group related content spatially; a section is not a flowchart step.

Native tables have cell text and row/column APIs. Inspect the exact methods before setting cells; generic scene-node children are not a reliable table model. Preserve merged ranges, headers and existing row order. Keep code blocks editable and use their declared language enum.

Validate node counts, connector endpoint IDs and labels, then export the relevant board region. Do not copy standalone-plugin examples that call `figma.closePlugin()` or install `figma.ui.onmessage`; the MCP connection owns that lifecycle.
