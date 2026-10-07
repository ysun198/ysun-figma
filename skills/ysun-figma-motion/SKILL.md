---
name: ysun-figma-motion
description: Read, author, export or implement Figma motion with ysun figma using actual native keyframes, animation styles, timelines, easing and video export capabilities.
---

# Native motion

Read [native execution](../ysun-figma/references/native-execution.md), use the exact file/IDs and check `figma_capabilities` plus real feature responses. Method presence does not prove entitlement; a free-plan assumption does not prove absence.

`figma_motion` reads native animations, manualKeyframeTracks, animationStyles, timelines and prototype reactions. Follow its bounded cursor with the same target/options. Preserve actual property names, typed values, seconds, easing, coordinate origins and loop behavior. A missing, failed or truncated read is not evidence of a static design.

Before authoring, search ManualKeyframeTrackInput, ManualKeyframeInput, Timeline, applyManualKeyframeTrack and AnimationStyle in the shared pinned types. Read the top-level frame's duration/timelines and existing tracks. Build against returned IDs, using the exact property types. Return changed IDs and read their persisted tracks; do not guess formats or flatten the animation into an image.

The native runtime rejects animation writes to product components, instance sublayers, parents of top-level frames and unsupported node types. Method presence does not override these structural restrictions. Preserve the original rejection and inspect the receipt; choose an actual supported target only when it fits the requested design, without detaching instances or flattening components merely to bypass the restriction.

`figma_export_node` uses Figma's native MP4/GIF/WEBM renderer when permitted. Target an animated FRAME directly under a PAGE. MP4/WEBM fps are 12/24/30/60; GIF fps are 8/12/15/24/30. Save its verified bytes with figma_export, observe playback/timed frames and respect the per-job byte budget. No fabricated video or animation is a successful export.

For code implementation, load [design-to-code](../ysun-figma-design-to-code/SKILL.md) and combine actual context with motion using the same node IDs. Use the repository's animation stack, preserve transform origins and identify native constructs with no equivalent. Watch a full cycle, including reduced-motion behavior where applicable, before propagating the pattern.

For prototype navigation/overlays rather than keyframe authoring, use [prototype](../ysun-figma-prototype/SKILL.md). Native shader application is described in [shaders](../ysun-figma/references/shaders.md); cloud shader source authoring is a separate service.
