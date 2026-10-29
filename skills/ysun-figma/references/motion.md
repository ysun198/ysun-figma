# Native Motion

Discover `ManualKeyframeTrackInput`, `ManualKeyframeInput`, `Easing`, `AvailableAnimationStyle` / `AppliedAnimationStyle`, `CustomAnimationStyle` and the containing frame timeline. Check `figma_capabilities` and actual feature responses. A missing entitlement needs a stated limit, not an approximation presented as native motion.

A default `timelines` entry can exist on a static node. `figma_motion` normally returns only effective motion/prototypes and an explicit root's timeline context; `includeStaticTimelines=true` includes static timelines throughout the search. `hasMotion` and counts apply to the returned result page. Follow every cursor and inspect issues before claiming absence. Snapshot animation fields before a cross-call decision, author with `figma_run(ifUnchanged=[snapshotJobId])`, then read back with `figma_motion`.

## Choose the representation

- Manual tracks express layer-specific values and timing.
- Discovered animation styles express existing reusable presets.
- Local custom animation styles are reusable file assets (`createCustomAnimationStyle`, `getLocalCustomAnimationStylesAsync` and the declared style setters).
- Editable within-text animation uses a discovered `TextStagger` definition, when the session exposes it. Do not create one text node per letter or rewrite characters on a timer.

Preserve unrelated static design, tracks and style applications. Do not detach instances or restructure components merely to bypass an actual unsupported target error.

## A manual track

```js
const node = await figma.getNodeByIdAsync(args.nodeId);
node.applyManualKeyframeTrack(
  { type: 'PROPERTY', name: 'OPACITY' },
  { keyframes: [
    { timelinePosition: args.start, value: { type: 'FLOAT', value: args.from }, easing: { type: 'HOLD' } },
    { timelinePosition: args.end, value: { type: 'FLOAT', value: args.to }, easing: args.easing },
  ] },
);
const timeline = node.timelines[0];
if (timeline && timeline.duration < args.end) node.setTimelineDuration(timeline.id, args.end);
return { nodeId: node.id, tracks: node.manualKeyframeTracks, timelines: node.timelines };
```

Timeline positions/durations are seconds. Translation is in pixels, rotation in degrees and scale is a multiplier. Preserve IDs/base values when updating an existing track. Extend the containing timeline when needed; shortening it changes other animation.

The easing of a keyframe describes the transition from the preceding keyframe. Use the public enum `EASE_IN_AND_OUT`, not the invented alias `EASE_IN_OUT`. `CUSTOM_CUBIC_BEZIER`, `CUSTOM_SPRING` and `HOLD` have distinct public shapes: retrieve `Easing` before setting their parameters.

## Fields and presets

The typed field union is the allowlist. It includes property tracks such as translation, rotation, scale, opacity, sizes, corners and supported trim fields; fills, strokes and effects have separate typed field/value structures. Do not invent vector-path, 3D-transform or internal scenegraph keyframe fields. A static supported property is not automatically animatable.

Read `figma.motion.figmaAnimationStyles()` before applying a preset. Its documentation/schema describes controls; it is not a ready-to-copy setter value. Record an applied style's returned ID and use that application ID for edits/removal; a preset definition ID is not an application ID.

For native text stagger, inspect the discovered schema and use the existing editable text layer. Grouping, ordering, total duration, delay, overlap and each included Position/Rotation/Scale/Opacity/Blur control have different meanings. A custom style binding is not the same object as a direct preset with editable props. Consult the actual application before changing either.

`node.animations` may contain only resolved manual tracks. Verify style-based edits through `animationStyles`, and custom styles through their native definitions; an empty manual-track result alone does not prove no motion.

A custom style is an ordered composition of existing first-party definitions. `style.addAnimationEntryAsync(definitionStyleId, props)` takes entry duration/easing inside `props`; applying that custom style to a node uses `{type: 'CUSTOM', timelineOffset}` without a separate duration/props bundle. Definitions, style entries and node application IDs are different identities. Custom styles do not nest. When custom-style access is gated, native reads can omit those bindings; do not stack a fallback animation onto motion that cannot be inspected.

## Verification without GUI

Use `figma_motion` for persisted tracks and durations. When visual sequencing is uncertain, export the actual animated top-level frame through `figma_export_node`, then inspect selected timestamps locally. Static screenshots show only the resting state. Use the renderer's actual supported format/fps/size and preserve an explicit plan rejection; do not bypass the gate. Verify a whole cycle when loops, reversal or cleanup are part of the request. Motion translated into application code must use the same track values, pivot, easing and timing; document any unsupported native construct rather than guessing it from screenshots.
