const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
test('Embed controller implements every command/event, binds exact iframe/origin, and distinguishes submission from acknowledgment', async () => {
  const { commands, events, createFigmaEmbedController } = await import(
    pathToFileURL(
      path.resolve(
        __dirname,
        '../skills/ysun-figma/references/embed-runtime.mjs',
      ),
    )
  );
  const listeners = new Map(),
    sent = [];
  const iframe = {
    src: 'https://embed.figma.com/proto/QaFile/QA?client-id=test',
    contentWindow: {
      postMessage: (message, origin) => sent.push({ message, origin }),
    },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const hostWindow = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const controller = createFigmaEmbedController({ iframe, hostWindow });
  assert.throws(() => controller.send('RESTART'), /INITIAL_LOAD/);
  const emit = (type, extra = {}) =>
    listeners.get('message')({
      origin: 'https://www.figma.com',
      source: iframe.contentWindow,
      data: { type, data: {} },
      ...extra,
    });
  emit('INITIAL_LOAD', { source: {} });
  emit('INITIAL_LOAD', { origin: 'https://example.com' });
  assert.equal(controller.state().ready, false);
  emit('INITIAL_LOAD');
  assert.equal(Object.keys(commands).length, 5);
  assert.equal(events.length, 7);
  for (const [type, keys] of Object.entries(commands)) {
    const data = Object.fromEntries(keys.map((key) => [key, '3:7']));
    assert.deepEqual(controller.send(type, data), {
      submitted: true,
      type,
      acknowledged: false,
    });
  }
  assert(sent.every((x) => x.origin === 'https://www.figma.com'));
  assert.throws(() => controller.send('UNKNOWN'), /Unknown/);
  assert.throws(
    () => controller.send('CHANGE_COMPONENT_STATE', { nodeId: '3:5' }),
    /Invalid/,
  );
  assert.throws(
    () => controller.send('RESTART', { access_token: 'bad' }),
    /Invalid/,
  );
  for (const event of events) emit(event);
  assert.deepEqual(
    controller
      .state()
      .events.slice(-7)
      .map((e) => e.type),
    events,
  );
  for (let i = 0; i < 110; i++) emit('NEW_STATE');
  assert.equal(controller.state().events.length, 100);
  controller.dispose();
  assert.equal(listeners.size, 0);
  assert.throws(() => controller.send('RESTART'), /disposed/);
});
