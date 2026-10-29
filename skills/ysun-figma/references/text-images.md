# Text, fonts and image fills

Look up `TextNode`, `TextSublayerNode`, `StyledTextSegment`, `TextStyle`, `ImagePaint`, `Image` and `TextPathNode` for exact signatures.

## Existing text

Load the actual fonts before changing text, range properties or text styles. Keep mixed ranges and user-selected fonts unless the request changes them:

```js
const text = await figma.getNodeByIdAsync(args.nodeId);
if (!text || text.type !== 'TEXT') throw new Error('Expected text');
await bridge.loadFonts(text);
text.characters = args.characters;
return { nodeId: text.id, characters: text.characters, bounds: [text.width, text.height] };
```

For new text, select the requested or source-defined face from `listAvailableFontsAsync`, await `loadFontAsync` with its exact family/style, then assign `fontName` and characters. Do not assume a style spelling or substitute a default typeface silently. A loaded font does not prove every requested glyph exists; inspect the native result when glyph coverage is uncertain.

Use range methods for mixed formatting (`setRangeFontName`, `setRangeFontSize`, hyperlinks and other supported range fields). `lineHeight` and `letterSpacing` are typed values with units, not plain numbers. Text can be editable on a path through `createTextPath`; do not outline characters merely to follow a curve.

Before setting wrapping width, load fonts, set `textAutoResize: 'HEIGHT'`, resize to a fixed width, then apply any valid parent sizing mode. Check the rendered lines and clipping; a successful character assignment is not visual acceptance.

## Styles and font variables

Create or reuse actual `TextStyle` IDs when the source has shared text roles. Apply styles through the async native setter. Font-family/style/weight variables and explicit mode changes can affect several faces: load the faces that the relevant mode values select before applying those bindings. Preserve scopes, aliases and code syntax rather than reducing a token to a literal.

## Images

`figma_upload_assets` imports local raster/SVG files and can replace one image fill on a known node. Use its actual returned sizes; setting both width and height deliberately stretches, while one dimension preserves aspect ratio. Keep image-fill replacement separate from geometry changes.

Within `figma_run`, transferred `bridge.assets[name]` can be passed to the native `figma.createImage`. Reusing an existing hash needs no upload. This differs from the official remote sandbox's upload-only rule; do not copy that restriction into native scripts.

`FIT`, `FILL`, `CROP` and `TILE` are not equivalent. Crop transforms are image transforms, not node transforms. Clone/reassign the fills array to update an image paint while preserving other paints, opacity and filters. Do not replace a content image with a flattened screenshot of the whole UI.

Paints also include gradients and supported media/shader types; effects and blend modes have their own typed schemas. Query `Paint` and `Effect` instead of reducing every requested effect to a solid fill. For native video fills, discover `createVideoAsync` and `VideoPaint`, pass actual transferred bytes when supported, and respect account/format gates. `createImage` is not a video importer.

When a newly created image is absent from an immediate export, verify its image hash and await `getImageByHash(hash).getSizeAsync()` before a later native export. Do not blindly re-upload the image or accept a blank render. Download original bytes through `figma_download_assets` when a handoff needs the source, rather than re-rendering a thumbnail.
