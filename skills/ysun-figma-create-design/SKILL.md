---
name: ysun-figma-create-design
description: Create or edit composed Figma Design screens and pages with ysun figma, including translating application source into editable native design structure.
---

# Create an editable design

Use [ysun-figma](../ysun-figma/SKILL.md) for exact file connection, and read [native execution](../ysun-figma/references/native-execution.md) before `figma_run`. Check the live editor/capabilities. For boards/diagrams use [FigJam](../ysun-figma-figjam/SKILL.md); for decks use [Slides](../ysun-figma-slides/SKILL.md); for interactive flows use [prototype](../ysun-figma-prototype/SKILL.md).

Inspect the intended page/subtree before writing. For a view based on code, read the source view, real assets, tokens and component states first. In Figma, use `figma_design_system` to find compatible existing components/variables/styles; explicit `scope="file"` includes other pages. Enabled library-variable discovery and already-used remote components are available locally; arbitrary cloud component-library enumeration is not. Import by a verified component key only when available, and preserve instances rather than immediately detaching them.

Build only the requested view/flow. Reuse its design language, assets and foundations. Use native text, shapes, instances, auto-layout and vector/raster fills, preserving editability. For images/SVG, use `figma_upload_assets` with a stable operation ID, compose from its assetName/nodeId mappings and actual dimensions, and verify the rendered result. A screenshot pasted as a full UI does not satisfy an editable screen request. No HTML/SwiftUI capture service is bundled; derive native structure from the actual source and clearly identify anything that cannot be represented faithfully.

Choose operation boundaries according to the view's dependencies and recovery cost; return created/changed IDs so subsequent work can use their actual identities. A horizontal row normally needs a content-sized counter axis (height), while its fixed width belongs to the primary axis: `bridge.autoLayout("HORIZONTAL", {width: actualWidth, primaryAxisSizingMode: "FIXED"})` keeps the automatic height. Do not set every container to a fixed 1px height. Use the runtime helpers for correct fonts/layout ordering. If new reusable components or tokens are needed, load [design-system workflow](../ysun-figma-design-system/SKILL.md) for that scope. Use the workflow for the requested editor; a supported manifest does not guarantee identical methods.

Read back hierarchy, bounds, text and bindings after changes. Use `await bridge.screenshot(root)` in the successful script or a separate local screenshot for visual verification. Verify the result in the actual requested editor; preserve the user's active page/selection/viewport unless navigating is part of the request. Clean up only exact task-owned IDs, never name-prefix matches. Use the original operation receipt after an interruption instead of duplicating the design.
