# Prototype Embed API

This is the browser iframe API, separate from native prototype authoring and REST oEmbed. Its packaged [browser adapter](embed-runtime.mjs) implements all five documented control messages and seven event types. Discover it with `figma_api(topic="embed")`. Import the module into the actual embedding page or its browser execution context; no GUI clicking is needed to control an already connected prototype.

The real Figma setup requires an OAuth app client ID and an allowed embed origin in that app's Embed API settings. A personal access token is not an embed client ID. An existing connector's OAuth grant does not authorize changing its allowed origins. Complete this setup only for an app/origin the user owns, then use `https://embed.figma.com/proto/FILE_KEY/NAME?client-id=CLIENT_ID&embed-host=HOST&node-id=NODE_ID`.

```js
import { createFigmaEmbedController } from './embed-runtime.mjs';
const controller = createFigmaEmbedController({
  iframe,
  onEvent: (event) => console.log(event.type, event.data),
});
// Construct/register before the iframe begins loading. Wait for INITIAL_LOAD.
controller.send('NAVIGATE_TO_FRAME_AND_CLOSE_OVERLAYS', { nodeId: '3:7' });
controller.send('CHANGE_COMPONENT_STATE', {
  nodeId: '3:5',
  newVariantId: '3:3',
});
controller.send('NAVIGATE_FORWARD');
controller.send('NAVIGATE_BACKWARD');
controller.send('RESTART');
controller.state();
controller.dispose();
```

The adapter checks the exact iframe window and Figma origin, rejects unknown commands/data, retains at most 100 events and removes its listeners on disposal. Posting a command is submission, not acknowledgment: verify PRESENTED_NODE_CHANGED or NEW_STATE and the actual rendering. LOGIN_SCREEN_SHOWN and PASSWORD_SCREEN_SHOWN are authentication requirements, not successful prototype loading. Tests cover all message/event routes, spoofed messages, initial readiness and disposal; this audit has not registered an embed origin or claimed a live prototype playback pass.

Contract: [official Embed API](https://developers.figma.com/docs/embeds/embed-api/), checked 2026-11-06. Use the embedding application's browser tools to execute this adapter; it is not an iframe hosted or controlled by the native Figma plugin.
