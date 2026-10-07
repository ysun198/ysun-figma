const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test(
  'failed receipt delivery is retained and retried without repeating a native operation',
  { timeout: 5000 },
  async () => {
    const messages = [],
      requests = [],
      elements = new Map();
    let offline = true;
    const parent = {
      postMessage(value) {
        messages.push(value.pluginMessage);
      },
    };
    const context = vm.createContext({
      parent,
      crypto: {
        getRandomValues: (bytes) =>
          require('node:crypto').randomFillSync(bytes),
      },
      AbortController,
      document: {
        getElementById(id) {
          if (!elements.has(id))
            elements.set(id, { value: '', dataset: {}, addEventListener() {} });
          return elements.get(id);
        },
      },
      addEventListener() {},
      setInterval() {},
      clearInterval() {},
      clearTimeout,
      // Accelerate the capped 10-second retry too; otherwise a busy test run can
      // reach that delay before the fixture goes online and never resolve it.
      setTimeout(fn, ms) {
        return ms <= 10000 ? setTimeout(fn, 0) : -1;
      },
      async fetch(url, options) {
        requests.push({ url, body: JSON.parse(options.body) });
        if (offline) throw new Error('relay disconnected');
        return {
          ok: true,
          status: 200,
          async json() {
            return { accepted: true };
          },
        };
      },
    });
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8'),
      context,
    );
    assert.match(vm.runInContext('direct.clientId', context), /^[a-f0-9]{32}$/);
    assert.ok(messages.some((message) => message.type === 'UI_READY'));
    const editor = {};
    parent.parent = { parent: editor };
    editor.parent = editor;
    assert.equal(
      context.trustedHostMessage({
        source: editor,
        origin: 'https://www.figma.com',
      }),
      true,
    );
    assert.equal(
      context.trustedHostMessage({
        source: editor,
        origin: 'https://attacker.example',
      }),
      false,
    );
    assert.equal(
      context.trustedHostMessage({
        source: {},
        origin: 'https://www.figma.com',
      }),
      false,
    );
    const completion = context
      .execute({
        id: 'job-once',
        kind: 'exec',
        source: 'return 42;',
        options: {},
      })
      .catch((error) => error);
    context.receipt = {
      type: 'APPLIED',
      requestId: 'job-once',
      result: { nodeIdMap: { root: 'native:1' } },
    };
    context.onmessage({ source: {}, data: { pluginMessage: context.receipt } });
    assert.equal(
      vm.runInContext('direct.pending.message', context),
      null,
      'unrelated windows cannot forge results',
    );
    vm.runInContext('direct.pending.message = receipt', context);
    const delivery = context.deliverReceipt();
    for (let i = 0; i < 100 && requests.length < 5; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert(requests.length >= 5);
    assert.ok(vm.runInContext('direct.pending.message', context));
    assert.equal(messages.filter((m) => m.type === 'RUN_JOB').length, 1);
    assert.equal(messages.filter((m) => m.type === 'CLOSE').length, 0);
    offline = false;
    await delivery;
    await completion;
    assert.equal(vm.runInContext('direct.pending', context), null);
    assert.equal(messages.filter((m) => m.type === 'RUN_JOB').length, 1);
    assert.equal(messages.filter((m) => m.type === 'CLOSE').length, 0);
    assert.equal(
      messages.filter((m) => m.type === 'RECEIPT_DELIVERED').length,
      1,
    );
    assert.ok(
      requests.every((request) =>
        request.url.endsWith('/v1/jobs/job-once/result'),
      ),
    );
    assert.ok(
      requests.every(
        (request) => request.body.result.nodeIdMap.root === 'native:1',
      ),
    );
  },
);

test('an uncertain receipt retains its identity and cannot be cleared by re-pairing', async () => {
  const messages = [],
    elements = new Map();
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
            addEventListener(event, fn) {
              this.listeners[event] = fn;
            },
          });
        return elements.get(id);
      },
    },
    addEventListener() {},
    setInterval() {},
    clearInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: async (url) => {
      if (url.includes('/jobs/next')) {
        vm.runInContext('direct.enabled=false', context);
        return { status: 204 };
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/v1/pair')
            ? {
                token: 'renewed',
                protocolVersion: 3,
                recovery: { active: [], unresolved: ['native-error'] },
              }
            : { accepted: true },
      };
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8'),
    context,
  );
  vm.runInContext(
    'direct.token="original";direct.context={fileName:"test",protocolVersion:3};',
    context,
  );
  const id = vm.runInContext('direct.clientId', context);
  const done = context.execute({
    id: 'native-error',
    kind: 'exec',
    options: {},
  });
  context.errorReceipt = {
    type: 'ERROR',
    requestId: 'native-error',
    outcomeUnknown: true,
    message: 'Native reaction failed',
  };
  vm.runInContext('direct.pending.message=errorReceipt', context);
  await context.deliverReceipt();
  await done;
  assert.equal(vm.runInContext('direct.blockedJobId', context), 'native-error');
  assert.match(elements.get('status').textContent, /Native reaction failed/);
  await context.run();
  assert.equal(messages.filter((m) => m.type === 'RUN_JOB').length, 1);
  vm.runInContext('byId("pair-code").value="new-code"', context);
  await context.pair();
  assert.equal(vm.runInContext('direct.clientId', context), id);
  assert.equal(vm.runInContext('direct.blockedJobId', context), 'native-error');
  assert.equal(vm.runInContext('direct.enabled', context), false);
});
