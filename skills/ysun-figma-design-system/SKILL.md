---
name: ysun-figma-design-system
description: Build or maintain Figma variables, styles, components, variants and repository code mappings with ysun figma. Use even for a single reusable component when token bindings and property ownership matter.
---

# Maintain one design system

Use [ysun-figma](../ysun-figma/SKILL.md) for exact targeting and [native execution](../ysun-figma/references/native-execution.md) for writes. Inspect the actual repository tokens/components and the target file with `figma_design_system`, `figma_variables` and `figma_components`. Paginate/search other pages when relevant. Inspect enabled variable libraries only when needed; the public local API cannot enable libraries or enumerate every cloud component library.

Inspect returned issues before treating a missing library as absent. A `teamlibrary` manifest permission error requires agent-managed re-import of the same stable manifest, as described in the core skill. Permission failures and unavailable libraries are different results.

Choose the source of truth from the user's task and actual project. Reuse or update existing compatible variables, styles and components before creating anything. If code and Figma disagree materially and the request does not settle it, expose the concrete conflict while completing independent work. Do not expand a component edit into a wholesale library rebuild.

Create missing foundations before dependent components. Use native collections, actual mode IDs, typed values, semantic aliases and relevant scopes/code syntax. Free-plan mode/feature limits apply; do not claim bypasses. Search `VariablesAPI`, `Variable`, `VariableCollection` and `setBoundVariableForPaint` in the shared public types for exact signatures. Resolve a color variable with `resolveForConsumer(node)` in the actual consumer's modes. Seed a new SOLID paint with that resolved RGB and alpha before binding; an arbitrary black placeholder can remain visible in native exports. Clone bound paints, reassign them and read bindings and rendered colors back.

For components, inspect the real property owner: a variant's definitions belong to its COMPONENT_SET. Reuse returned property names and IDs. Model actual independent axes, boolean/text/instance-swap properties and states; avoid extra variants for replaceable icons. Build new variants with readable placement, combine them, and return the exact set/variant IDs. Instantiate the intended variant and verify its exposed properties and token bindings, not only its screenshot.

`ComponentNode.clone()` defaults to the current page, as the public API specifies. Append a cloned variant to its intended component set before wiring CHANGE_TO. Inspect the clone's actual componentPropertyReferences and then exercise an instance with different text/boolean/swap values: a correct instance property table does not prove that internal layers are linked. One observed native clone lost text references; verify and repair only missing references using the existing property IDs, rather than assuming every clone fails or recreating properties.

Read and maintain the repository's existing Code Connect files/configuration when requested. Map only real component props/imports, cover actual variant values, and preserve dynamic child/instance slots. Respect its parserless or parser-based format rather than rewriting it speculatively. Local source-file maintenance does not publish to hosted Code Connect; official suggestions/mappings/plan APIs are a separate service. Do not generate a new local JSON database as a substitute for that service.

Run writes sequentially with stable operation IDs and returned-ID receipts. Validate created/changed variables, aliases, modes, components and instances against the selected scope. Clean up only task-owned node/variable/collection IDs recorded in those receipts; preserve unrelated foundations. Compare actual rendered component states and relevant project code. Report missing library access or hosted integration accurately.
