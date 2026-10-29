# Native shader application

Check the live capabilities and actual feature responses. A declaration is not an entitlement.

The public API exposes `listAvailableShaders`, `importShaderById` and native shader-fill properties when available. Inspect that actual list and schema before applying. An empty list means no available entries in that context, not proof that the API is absent. Clone/reassign fills with exact shader property types from the API. Preview the real rendered result.

Use the ordinary capability probe for method presence; request `includeResources=true` only to enumerate actual shaders. That enumeration can require cloud access. Inspect `Shader`, `ShaderPaint`, `ShaderEffect` and `ShaderPropertyValue` through `figma_api`. An entry with `imported: false` must be materialized with `await figma.importShaderById(id)` before use; read its populated `propertyDefinitions`. Property assignments use definition IDs, not display names. A fill shader belongs in fills/strokes; an effect shader belongs in effects. Preserve other paints/effects and the shader's actual kind.

An applied `ShaderPaint` can expose read-only `propertyMetadata`, keyed like its property values. Use those definitions when returned; do not write metadata or assume every runtime supplies it.

The local Plugin API does not expose the official cloud shader/generative-plugin source libraries, scaffold compiler or author/version lifecycle. Do not claim local GLSL files or native fill edits implement those services. Report that distinction when the user requests cloud authoring.
