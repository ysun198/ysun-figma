# Native vector geometry

Use `figma_api` to inspect `VectorNode`, `VectorNetwork`, `VectorVertex`, `VectorSegment`, `VectorRegion`, `VectorPath`, `GeometryMixin`, `CornerMixin` and `MaskType`. The existing Figma vector is the editing source; do not automatically replace it with an external image or a rebuilt approximation.

## Paths and networks

- New vectors have native default paints, including a stroke. For a fill-only glyph, set `vector.strokes = []` explicitly; copying only geometry/fills can leave an unintended 1 pt outline. Preserve existing strokes when editing artwork that uses them.
- `vectorPaths` accepts path data and a winding rule. `EVENODD` and `NONZERO` interpret nested contours differently; choose the intended rule explicitly for holes.
- `setVectorNetworkAsync` updates connected vertices, segments and regions. Segment tangents are offsets relative to their vertices, not absolute control-point positions.
- Keep shared intersections as shared vertices. Independently rounding or moving adjacent shapes is not a guarantee that their visible boundaries still meet.
- `fillGeometry` and `strokeGeometry` are rendered read-only geometry. A visible stroke is not the same contour as its centreline.
- `strokeAlign`, `strokeCap`, `strokeJoin`, miter limits, dash patterns and per-side weights have different jobs. Inspect them instead of approximating a cap with extra shapes.
- Corner radius and `cornerSmoothing` affect supported native shapes. Use a curve/control-point edit for a specific path transition; do not assume a large global radius preserves small edges or holes.

## Targeted network edit

```js
const vector = await figma.getNodeByIdAsync(args.nodeId);
if (!vector || vector.type !== 'VECTOR') throw new Error('Expected a vector');
const network = JSON.parse(JSON.stringify(vector.vectorNetwork));
const vertex = network.vertices[args.vertexIndex];
if (!vertex) throw new Error('Unknown vertex');
vertex.x = args.x;
vertex.y = args.y;
await vector.setVectorNetworkAsync(network);
return { nodeId: vector.id, vertices: vector.vectorNetwork.vertices.length };
```

A network edit is in the vector's local space. Preserve unrelated segments, regions and paint overrides. Read back the changed points and export at the actual target size when pixel placement matters.

For a new vector with per-region paints, set node-level defaults **before** `setVectorNetworkAsync(network)`. Assigning `vector.fills` afterward can overwrite region paints/opacity. For an existing vector, clone and edit the actual region paints in its network, then read back `vector.vectorNetwork.regions`; do not reassign node fills as a finishing step.

## Booleans and flattening

`union`, `subtract`, `intersect` and `exclude` produce editable boolean nodes. Use the actual parent and local transforms; a boolean may renormalize its bounds when a child changes. Rebuilding a scoped compound glyph inside its own local frame can be safer than changing a deeply nested boolean in several coordinate systems.

Subtraction follows sibling stacking order. Put the base below the cutters in their actual parent before subtracting; array order alone does not establish that stacking order.

`flatten` commits the result to a vector and removes the original boolean/component structure. Use it only when that is the requested representation. Preserve the previous editable source if it is still needed.

Flattened vectors may retain explicit paints in `vectorNetwork.regions`. Changing node-level `fills` does not necessarily override those region paints. If the requested result is a single-colour template, remove only the region paint overrides intentionally, then assign the node paint:

```js
const vector = await figma.getNodeByIdAsync(args.nodeId);
const network = JSON.parse(JSON.stringify(vector.vectorNetwork));
for (const region of network.regions || []) {
  delete region.fills;
  delete region.fillStyleId;
}
await vector.setVectorNetworkAsync(network);
vector.fills = args.fills;
return { nodeId: vector.id, fills: vector.fills };
```

Do not run that normalization on intentionally multicolour artwork.

## SVG, masks and exports

`figma.createNodeFromSvg` creates editable native geometry. Keep its viewBox/canvas and child bounds distinct. Use `figma_upload_assets` for repeated local SVG imports and its returned IDs/dimensions for composition.

For a mask, set the actual mask type (`ALPHA`, `VECTOR` or `LUMINANCE` when supported), put it before the masked siblings and keep the intended group/frame boundary. Mask scope follows hierarchy and sibling order. `clipsContent` is a frame crop rather than a substitute for every mask.

Export SVG with native settings when the deliverable must remain vector. Verify transparency, holes, stroke weights and both intended foreground/background combinations. A magnified preview supplements the intended-size native render; it does not replace it.

Exporting a child does not isolate it from its ancestors: hidden/zero-opacity ancestors, masks and clipping can produce an empty or 1×1 PNG. Check the requested node's ancestry and bounds before changing its geometry. PNG export entries include `image.width`, `image.height` and `image.fullyTransparent`; `null` means alpha inspection was unavailable, not that the image is visible. Successful byte delivery does not establish visual correctness. If an isolated render is needed, clone into an owned temporary frame, preserve coordinates, export, then remove that frame without changing the source or the user's page/selection.
