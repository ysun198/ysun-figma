---
name: ysun-figma-slides
description: Create, restyle or edit a native Figma Slides deck with ysun figma, including slide grid placement, editable assets and validation of persisted content or presenter notes.
---

# Native Slides

Use [files](../ysun-figma-files/SKILL.md) and [native execution](../ysun-figma/references/native-execution.md). Check the actual editor/capabilities. Create a cloud deck through normal authenticated Figma UI when needed.

Use `figma.getSlideGrid()` to discover the deck, and `createSlide`/`createSlideRow` only when available. Grid rows are arrays of slides, not SLIDE_ROW nodes. Newly inserted rows/slides can appear only after the creation script returns; inspect in a following operation. Figma can normalize section names back to Section, even after a later setter. Read persisted state and use the actual editor when a section name matters.

`getSlideGrid()` returns a read-only outer array. For explicit ordering, copy its rows with `grid.map(row => [...row])`, modify that copy, then call `setSlideGrid(nextGrid)`. A native created slide can exist under a row while still absent from the returned grid; confirm its exact ID and parent before adding that same slide to the intended grid. Do not recreate it or invent its position from its name.

Do not create Design pages or style the opaque slide grid as a frame. A slide is the editable content container; reuse its actual size, theme variables and text styles. Preserve existing slides during a restyle. Append each nested node to its destination before assigning x/y; do not hardcode hidden grid-origin compensation. Asset imports need the destination slide's parentId. Use native text/vector/image structure rather than a screenshot as the whole slide.

The pinned native types do not declare the official remote speakerNotes, slideThemeId or focused-slide conveniences. Do not create JavaScript properties and call that successful editing. For notes, if needed and available, use the actual editor's editable notes area, commit the text through normal input, change slides and return to verify persistence. An accessibility setValue alone may not commit it.

Inspect coordinates, text bounds and overlap in each slide's own coordinate system. Preview representative slides after establishing direction and at completion; validate presenter notes/playback in the actual editor when requested. Use exact returned IDs and original receipts for continuation and cleanup.
