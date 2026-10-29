# Layout, coordinates and transforms

Look up `AutoLayoutMixin`, `AutoLayoutChildrenMixin`, `GridLayoutMixin`, `Constraints`, `Transform`, and `SceneNodeMixin` with `figma_api`. Read the actual frame before editing its layout; do not impose a layout model when absolute geometry is intentional.

## Parent space

`x/y` are in the immediate parent's space. `absoluteTransform` is read-only; set `relativeTransform` when preserving a world-space position across reparenting. A transform is `[[a,c,tx],[b,d,ty]]`, not a CSS transform string. Preserve rotations, reflections and scale by multiplying the inverse new-parent transform by the old absolute transform; subtracting two x/y values works only for unrotated, unscaled coordinate systems.

Append a new node to its final parent before assigning parent-relative coordinates. SVG imports are frames whose children may have nonzero local bounds. Preserve those child offsets when extracting a vector; the SVG canvas origin and its painted bounds need not coincide. Use `node.rescale(factor)` when scaling a subtree's strokes, text and geometry together; resizing a frame is a different operation.

## Auto Layout

For content that must reflow, use native flow rather than positioning every child separately:

```js
const parent = await figma.getNodeByIdAsync(args.parentId);
const row = bridge.autoLayout('HORIZONTAL', {
  width: args.width,
  height: args.initialHeight,
  primaryAxisSizingMode: 'FIXED',
  counterAxisSizingMode: 'AUTO',
  itemSpacing: args.gap,
});
parent.appendChild(row);
const child = figma.createFrame();
row.appendChild(child);
child.resize(args.initialWidth, args.initialHeight);
child.layoutSizingHorizontal = 'FILL';
return { rowId: row.id, childId: child.id, bounds: [row.width, row.height] };
```

- Frame `primaryAxisSizingMode`/`counterAxisSizingMode` use `FIXED` or `AUTO`.
- Node `layoutSizingHorizontal`/`layoutSizingVertical` use `FIXED`, `HUG` or `FILL`, subject to the actual parent/child context.
- Parent first, fixed resize next, HUG/FILL last. `resize` can reset sizing modes.
- `layoutPositioning: 'ABSOLUTE'` removes a child from normal flow; use it intentionally.
- Wrapping uses `layoutWrap`, `counterAxisSpacing` and the relevant alignment properties. Baseline alignment is different from geometric centre alignment.
- Wrapping text generally needs a fixed width plus `textAutoResize: 'HEIGHT'`; width-and-height auto resize can defeat wrapping.

## Native grids

Layout grids used as guides (`layoutGrids`) and grid Auto Layout (`layoutMode: 'GRID'`) are distinct features. Native grid Auto Layout supports row/column counts, gaps, sizing tracks and child spans/positions. Discover the exact `grid*` properties and track types before setting them; do not simulate an editable grid by arranging unrelated rectangles. `bridge.autoLayout` handles horizontal/vertical flow; create a frame and set native GRID properties for a grid.

## Constraints and clipping

Constraints apply within the parent and do not replace Auto Layout. `clipsContent` clips descendants to a frame, while a mask uses a separate masking node and ordering. Read existing constraints before resizing. Confirm both native bounds and the rendered result when clipping, wrapping or transforms matter; bounds alone do not prove content is visible.
