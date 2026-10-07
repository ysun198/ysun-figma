const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function ui(handler, globals = {}) {
  const messages = [],
    elements = new Map(),
    requests = [];
  const parent = {
    postMessage(value) {
      messages.push(value.pluginMessage);
    },
  };
  const context = vm.createContext({
    parent,
    AbortController,
    crypto: {
      getRandomValues: (b) => require('node:crypto').randomFillSync(b),
    },
    document: {
      getElementById(id) {
        if (!elements.has(id))
          elements.set(id, {
            value: '',
            dataset: {},
            listeners: {},
            addEventListener(n, fn) {
              this.listeners[n] = fn;
            },
          });
        return elements.get(id);
      },
    },
    addEventListener() {},
    setInterval() {
      return -1;
    },
    clearInterval() {},
    clearTimeout,
    setTimeout(fn, ms) {
      return ms <= 10000 ? setTimeout(fn, 0) : -1;
    },
    async fetch(url, options) {
      requests.push({
        url,
        body: options.body ? JSON.parse(options.body) : null,
      });
      return handler(url, options, context, requests);
    },
    ...globals,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/figma/ui.js'), 'utf8'),
    context,
  );
  vm.runInContext(
    'direct.token="fixture-token";direct.context={fileName:"fixture"};',
    context,
  );
  return { context, messages, elements, requests };
}
const response = (value = {}, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});

test('a temporary poll outage resumes without a click or a second native write', async () => {
  let polls = 0;
  const f = ui(async (url, options, c) => {
    if (url.endsWith('/heartbeat'))
      return response({ recovery: { active: [], unresolved: [] } });
    if (++polls === 1) throw new Error('temporary link failure');
    vm.runInContext('direct.enabled=false', c);
    return response({}, 204);
  });
  await f.context.run();
  assert.equal(polls, 2);
  assert.equal(f.messages.filter((m) => m.type === 'RUN_JOB').length, 0);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/v1/pair')).length, 0);
});
test('a lost claim response is not mistaken for a harmless disconnection', async () => {
  const f = ui(async (url) => {
    if (url.endsWith('/heartbeat'))
      return response({
        recovery: { active: ['already-claimed'], unresolved: [] },
      });
    throw new Error('reply lost');
  });
  await f.context.run();
  assert.equal(
    vm.runInContext('direct.blockedJobId', f.context),
    'already-claimed',
  );
  assert.equal(f.messages.filter((m) => m.type === 'RUN_JOB').length, 0);
  assert.equal(
    f.requests.filter((r) => r.url.includes('/jobs/next')).length,
    1,
  );
});
test('authentication failure stops rather than silently authorizing a new session', async () => {
  const f = ui(async () => response({ error: 'session expired' }, 401));
  await f.context.run();
  assert.equal(f.requests.length, 1);
  assert.equal(vm.runInContext('direct.enabled', f.context), false);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/v1/pair')).length, 0);
});
test('receipt retries outlast a brief retry window without re-executing the operation', async () => {
  const f = ui(async (url, options, c, calls) => {
    if (calls.length <= 6) throw new Error('offline');
    return response({ accepted: true });
  });
  const finished = f.context
    .execute({ id: 'native-once', kind: 'exec', options: {} })
    .catch((e) => e);
  f.context.receipt = {
    type: 'APPLIED',
    requestId: 'native-once',
    result: { nodeId: 'existing-id' },
  };
  vm.runInContext('direct.pending.message=receipt', f.context);
  await f.context.deliverReceipt();
  await finished;
  assert.equal(f.requests.length, 7);
  assert.equal(vm.runInContext('direct.pending', f.context), null);
  assert.equal(f.messages.filter((m) => m.type === 'RUN_JOB').length, 1);
  assert(f.requests.every((r) => r.url.endsWith('/native-once/result')));
});
test('an outdated recovery response cannot authorize another poll', async () => {
  const f = ui(async (url) => {
    if (url.endsWith('/heartbeat'))
      return response({ client: { id: 'fixture' } });
    throw new Error('offline');
  });
  await f.context.run();
  assert.equal(f.requests.length, 2);
  assert.match(f.elements.get('status').textContent, /recovery|Recovery/);
});

test('a transient heartbeat does not pause an executing native operation', async () => {
  const f = ui(async () => {
    throw new Error('temporary network failure');
  });
  vm.runInContext('direct.enabled=true', f.context);
  await f.context.heartbeat();
  assert.equal(vm.runInContext('direct.enabled', f.context), true);
  assert.equal(f.messages.filter((m) => m.type === 'SHOW_UI').length, 0);
});
test('native context changes push promptly, coalesce while a heartbeat is in flight and never loop on unchanged GET_CONTEXT replies', async () => {
  let release;
  const f = ui(async (url, options, c, calls) => {
    assert(url.endsWith('/heartbeat'));
    if (calls.length === 1)
      return new Promise((resolve) => {
        release = resolve;
      });
    return response({ recovery: { active: [], unresolved: [] } });
  });
  vm.runInContext('direct.enabled=true', f.context);
  const notify = (revision) =>
    f.context.onmessage({
      source: f.context.parent,
      data: {
        pluginMessage: {
          type: 'CONTEXT',
          fileName: 'fixture',
          documentRevision: revision,
        },
      },
    });
  notify(1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.documentRevision, 1);
  notify(2);
  notify(3);
  notify(3);
  assert.equal(f.requests.length, 1);
  release(response({ recovery: { active: [], unresolved: [] } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].body.documentRevision, 3);
  notify(3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 2);
  assert.equal(f.messages.filter((m) => m.type === 'GET_CONTEXT').length, 2);
});
test('a closed plugin instance stops connection recovery', async () => {
  const f = ui(async (url, options, c) => {
    vm.runInContext('direct.closed=true;direct.enabled=false', c);
    throw new Error('closing');
  });
  await f.context.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.messages.filter((m) => m.type === 'RUN_JOB').length, 0);
});
test('native reopen waits for an old instance lease without asking for a code or taking over its session', async () => {
  let attempts = 0;
  const f = ui(async () =>
    ++attempts < 3
      ? response(
          {
            error:
              'this document is already connected in another plugin window',
          },
          409,
        )
      : response({
          protocolVersion: 3,
          token: 'restored',
          expiresAt: Date.now() + 3600000,
          recovery: { active: [], unresolved: [] },
        }),
  );
  vm.runInContext(
    'direct.grantToken="saved-grant";direct.context.protocolVersion=3;',
    f.context,
  );
  await f.context.restoreOnOpen();
  assert.equal(attempts, 3);
  assert.equal(vm.runInContext('direct.token', f.context), 'restored');
  assert(f.requests.every((r) => r.url.endsWith('/v1/resume')));
});
test('a genuinely live duplicate instance stays protected after the bounded reopen wait', async () => {
  let now = 0;
  const f = ui(
    async () => {
      now += 10000;
      return response(
        {
          error: 'this document is already connected in another plugin window',
        },
        409,
      );
    },
    { Date: { now: () => now } },
  );
  vm.runInContext(
    'direct.grantToken="saved-grant";direct.context.protocolVersion=3;',
    f.context,
  );
  await assert.rejects(f.context.restoreOnOpen(), /already connected/);
  assert.equal(f.requests.length, 5);
  assert.equal(vm.runInContext('direct.token', f.context), 'fixture-token');
});
