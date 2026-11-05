# Native Slides

Confirm `editorType === 'slides'`. Look up `SlideNode`, `SlideRowNode`, `SlideGridNode`, `SlideTransition` and supported interactive-slide elements. A Design frame named “slide” is not a native slide.

## Grid lifecycle

Use the current `getCanvasGrid()` / `setCanvasGrid()` APIs for the Slides canvas grid. The grid can contain slides and other supported canvas assets, so preserve every existing node when rearranging it. `getSlideGrid()` / `setSlideGrid()` are deprecated compatibility APIs. `createSlide()` inserts into the grid; `createSlide(rowIndex, columnIndex)` chooses an actual position. `createSlideRow()` creates a section row, and Figma may normalize its title back to `Section` after creation.

A new deck may have an empty grid. Do not assume grid[0][0], a theme source or a first slide exists. Create a requested slide or handle the empty case before reading its properties. Retain the actual native slide dimensions; do not impose a fixed canvas size or design theme.

```js
if (figma.editorType !== 'slides') throw new Error('Expected Slides');
const before = figma.getCanvasGrid();
const slide = figma.createSlide();
await figma.loadFontAsync(args.font);
const label = figma.createText();
label.fontName = args.font;
slide.appendChild(label);
label.characters = args.title;
label.x = args.x;
label.y = args.y;
return {
  slideId: slide.id,
  textId: label.id,
  previousRows: before.length,
  size: [slide.width, slide.height],
};
```

Read `getCanvasGrid()` in a following operation: native insertion can become visible in the grid only after the creation script returns. An existing returned slide ID must not be recreated merely because it is temporarily absent from that grid.

## Content and properties

Native text, vectors, image fills and components remain editable on the slide. Load exact fonts for edits and verify wrapping/clipping. Use actual slide properties for transitions, slide skipping and supported native interactive elements; discover the property shape before writing. A slide transition is not a manual animation track.

Batch coherent edits across existing slides when safe; return slide/node IDs and actual grid order. Avoid page creation and Design-only APIs unless the live Slides editor advertises them. Do not copy the official remote executor's page-reset or slide-theme helper assumptions into the native runtime.

## Notes and verification

The official remote `speakerNotes`, `slideThemeId` and focused-slide conveniences are not declared public methods in our pinned native API. Do not assign undeclared JavaScript fields and claim a notes edit succeeded. Probe an advertised live API if present; otherwise report the concrete native limitation. A screenshot cannot verify presenter-note persistence.

For normal content, inspect the persisted grid and native render through MCP. Actual presentation controls, keyboard navigation, focus and presenter behavior require a real interactive acceptance test when requested; mark that separately from native structure/export verification.
