// Figma Embed API adapter. Official contract checked 2026-11-06:
// https://developers.figma.com/docs/embeds/embed-api/
export const commands = Object.freeze({
  NAVIGATE_TO_FRAME_AND_CLOSE_OVERLAYS: ['nodeId'],
  NAVIGATE_FORWARD: [],
  NAVIGATE_BACKWARD: [],
  CHANGE_COMPONENT_STATE: ['nodeId', 'newVariantId'],
  RESTART: [],
});
export const events = Object.freeze([
  'MOUSE_PRESS_OR_RELEASE',
  'PRESENTED_NODE_CHANGED',
  'INITIAL_LOAD',
  'NEW_STATE',
  'REQUEST_CLOSE',
  'LOGIN_SCREEN_SHOWN',
  'PASSWORD_SCREEN_SHOWN',
]);
export function createFigmaEmbedController({
  iframe,
  hostWindow = globalThis.window,
  onEvent = () => {},
}) {
  const url = new URL(iframe.src);
  if (
    !['https://embed.figma.com', 'https://www.figma.com'].includes(
      url.origin,
    ) ||
    !url.pathname.startsWith('/proto/') ||
    !url.searchParams.get('client-id')
  )
    throw new Error(
      'An official prototype iframe with a registered client-id is required',
    );
  const origin = 'https://www.figma.com';
  let ready = false,
    disposed = false,
    sequence = 0;
  const history = [];
  const listener = (event) => {
    if (
      disposed ||
      event.origin !== origin ||
      event.source !== iframe.contentWindow ||
      !events.includes(event.data?.type)
    )
      return;
    if (event.data.type === 'INITIAL_LOAD') ready = true;
    if (
      ['LOGIN_SCREEN_SHOWN', 'PASSWORD_SCREEN_SHOWN', 'REQUEST_CLOSE'].includes(
        event.data.type,
      )
    )
      ready = false;
    const value = {
      sequence: ++sequence,
      type: event.data.type,
      data: event.data.data ?? {},
    };
    history.push(value);
    if (history.length > 100) history.shift();
    onEvent(value);
  };
  const loading = () => {
    ready = false;
  };
  hostWindow.addEventListener('message', listener);
  // Register before assigning/loading the iframe URL, so INITIAL_LOAD is observed.
  iframe.addEventListener('load', loading);
  return {
    send(type, data = {}) {
      if (disposed) throw new Error('Embed controller is disposed');
      if (!Object.hasOwn(commands, type))
        throw new Error('Unknown Embed API command');
      const required = commands[type];
      if (
        !data ||
        typeof data !== 'object' ||
        Object.keys(data).some((key) => !required.includes(key)) ||
        required.some((key) => typeof data[key] !== 'string' || !data[key])
      )
        throw new Error('Invalid Embed API command data');
      if (!ready)
        throw new Error(
          'Wait for INITIAL_LOAD before sending a prototype command',
        );
      const message = {
        type,
        ...(required.length ? { data: { ...data } } : {}),
      };
      iframe.contentWindow.postMessage(message, origin);
      return { submitted: true, type, acknowledged: false };
    },
    state: () => ({
      ready,
      disposed,
      sequence,
      events: history.map((event) => ({
        ...event,
        data: structuredClone(event.data),
      })),
    }),
    dispose() {
      disposed = true;
      ready = false;
      hostWindow.removeEventListener('message', listener);
      iframe.removeEventListener('load', loading);
    },
  };
}
