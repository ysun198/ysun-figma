# Paints, colors and effects

Read `Paint`, `Effect`, `ColorWithColorSpace`, `RGBWithColorSpace` and `RGBAWithColorSpace` for the actual schema. Paints and effects are immutable value arrays: clone the affected value, change it and reassign the array. Preserve existing variable bindings and unrelated fills/effects.

The native utilities `figma.util.rgb`, `rgba` and `solidPaint` accept supported CSS color strings and color-space objects. They differ from hosted-only helpers such as SF Symbol lookup. Probe the actual method when runtime support matters.

Since [Plugin API update 141](https://developers.figma.com/docs/plugins/updates/2026/10/15/version-1-update-141/), `sourceColor` preserves the authored color space and components. Existing RGB values are the projection into the document profile. Preserve `sourceColor` when reproducing an existing paint, gradient stop or effect; do not silently flatten Display P3, OKLAB or OKLCH to sRGB. Inspect the declared writable shape before assigning a color; successful parsing alone does not establish the rendered output or display gamut.

`GradientPaint` includes stops and a transform. `ImagePaint` cropping uses `imageTransform`, separate from node geometry; follow [image guidance](text-images.md). `VideoPaint` needs actual video bytes through `createVideoAsync`, not `createImage`. Shader fills/effects use the definitions returned by the native library; see [shaders](shaders.md).

Effects, blend modes, individual stroke weights, joins/caps and brushes have distinct schemas. Load the brush family through `loadBrushesAsync` before setting its declared field. Check a native export at the actual target size when appearance matters.
