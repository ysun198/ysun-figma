# Code and design handoff

Choose the requested direction and artifact. Existing verbs/source context usually resolve it; ask only when code vs design output is genuinely ambiguous. Preserve the project's current framework, components, formats and authorization scope.

## Design to application code

Read the relevant native context, original assets, variable/style bindings, component owners and a native export. Use the source repository's actual component and token APIs; do not translate each absolute Figma coordinate into a separate absolutely positioned view. Keep native component properties, states, resizing, masks and interaction intent explicit in the implementation.

For SwiftUI, map layout intent to actual stack/grid/container behavior, preserve existing semantic colours and accessibility labels, and retain system-symbol names when the source provides them. A glyph character or an image thumbnail does not establish an SF Symbol's name. The remote `figma.util.getSfSymbolCharacter` helper is not available locally: do not invent private-use codepoints.

For motion, read real tracks/styles/timelines, then preserve units, pivots, delays and easing in the target framework. A screenshot describes a resting pose, not the motion. Inspect final application behavior at its target size when the user requests implementation.

## Source code to editable design

Read the actual source hierarchy, assets, fonts, layout rules, tokens and states. Reuse matching native components/variables/styles and construct native text, vector/image content and containers. Use source measurements as evidence; choose native flow or fixed geometry according to the actual component behavior. Keep content images separate from whole-screen reference captures.

The deliverable's UI must be editable layers. A screenshot fill, HTML screenshot or flattened full-screen SVG is a reference rather than semantic recreation. No hosted HTML capture/HTML-to-Figma/Make service is bundled; do not claim that running a local renderer implements those cloud services.

## Code Connect formats

Inventory the repository's actual format before writing:

- Parser-based SDK mappings can use `.figma.tsx` / `figma.connect`, Swift `FigmaConnect` or other supported SDK formats.
- The installed official parserless workflow uses `.figma.ts`, `import figma from 'figma'`, `figma.selectedInstance` and a `figma.code` default-export example; its older API reference also shows `.figma.js`. Check the repository's actual include patterns and installed types. These are template-runtime APIs, not native Plugin API methods.

Preserve an existing format and its config; do not overwrite one with the other. Resolve the native master/property owner, then map only real code props. TEXT, BOOLEAN, VARIANT, INSTANCE_SWAP and SLOT need different handling; nested configurable instances/slots must stay dynamic. A local JSON registry or Dev Resource URL is not a hosted Code Connect publication.

Validate against the actual installed SDK/template types and source component signature. Use repository validation commands where available. Authoring local mapping files is separate from publishing them; a successful local type check does not establish hosted eligibility, authentication or publication.

## Native handoff resources

`getCSSAsync` provides native CSS evidence. `getDevResourcesAsync`, `addDevResourceAsync` and related methods connect native nodes to actual resource URLs when supported. Keep links portable and point at existing authorized destinations. Adding links does not upload code, publish a library or create hosted Code Connect mappings.

`JSON_REST_V1` exports native node data in the REST-shaped schema without a REST token. It is useful for tooling/handoff, but does not guarantee `.fig` reconstruction or include every external dependency. Keep original SVG/raster assets and variable/style identity evidence when the handoff needs them.
