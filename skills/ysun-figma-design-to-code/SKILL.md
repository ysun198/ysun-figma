---
name: ysun-figma-design-to-code
description: Implement a Figma design in an existing repository using ysun figma local structure, tokens, original assets and screenshots. Use for design-to-code, including web, SwiftUI and motion implementation.
---

# Implement the actual design

Use the local connection/targeting workflow in [ysun-figma](../ysun-figma/SKILL.md). The deliverable is working code in the requested project stack; native JSON/CSS are design evidence, not finished application code.

Read the target repository's components, tokens, navigation and conventions. Obtain `figma_design_context` for the exact node; a single exportable root includes its screenshot and variable/style references by default. Read `issues`, `sparse` and child truncation. Drill into returned child IDs until the required visible structure is accounted for. Use `figma_screenshot` if the context did not obtain a usable preview. Do not infer a whole design from a partial tree.

Reuse actual project components before adding new ones. For Figma instances, inspect `component` and `component.propertyOwner`; search real `.figma.ts`, `.figma.tsx`, code mapping/config files and their source components. Respect the mapping format already used by the project. A matching layer name is insufficient proof of a component mapping. Do not create a parallel mapping registry or pretend the official hosted Code Connect service is connected.

Use `figma_download_assets` to save original image-fill bytes and native vector/icon exports. Preserve crop, transform and scaling metadata from design context. An image-backed screenshot of an entire UI is not an implementation asset. Reuse original vectors/raster assets instead of redrawing them with placeholder CSS. The local tool saves verified files without ephemeral remote asset URLs or overwriting existing files.

Translate layout, typography, colors and component states into the project's native abstractions. Resolve aliases/modes rather than replacing tokens with copied literals. Preserve the design's hierarchy while respecting responsive behavior the task calls for. For SwiftUI, use actual assets, existing view components and current platform APIs; use SF Symbols only when an existing mapping or the user identifies them, not a guessed substitute.

If motion exists or is requested, load [motion](../ysun-figma-motion/SKILL.md), fetch `figma_motion` and join by exact node ID. The local tool returns tracks rather than official generated snippets. Validate timing/origins in real playback.

Run the checks appropriate to the code change and compare the actual rendered target with the Figma preview at a representative viewport. Check requested interaction and responsive states; passing compilation or obtaining a screenshot alone does not establish fidelity. State any evidence or service limitation that remains.
