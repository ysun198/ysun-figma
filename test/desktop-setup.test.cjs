const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readRegistration,
  registerDesktopPlugins,
} = require('../src/host/desktop-registration.cjs');
const { profileInfo, profiles } = require('../src/host/native-profiles.cjs');
const {
  inspectApp,
  installDesktopApp,
  quitDesktop,
} = require('../src/host/desktop-app.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-desktop-setup-'));
  const previous = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = path.join(root, 'state');
  const home = path.join(root, 'home');
  for (const name of Object.keys(profiles)) {
    const p = profileInfo(name);
    fs.mkdirSync(path.dirname(p.manifestPath), { recursive: true });
    fs.writeFileSync(
      p.manifestPath,
      JSON.stringify({ id: p.pluginId, main: 'code.js', ui: 'ui.html' }),
    );
    fs.writeFileSync(path.join(path.dirname(p.manifestPath), 'code.js'), '');
    fs.writeFileSync(path.join(path.dirname(p.manifestPath), 'ui.html'), '');
  }
  t.after(() => {
    if (previous === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(
    home,
    'Library/Application Support/Figma/settings.json',
  );
  function write(settings) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings));
  }
  return { root, home, file, write };
}

test('first registration preserves foreign plugins and settings, retains an exact private backup and is idempotent', async (t) => {
  const f = fixture(t);
  const foreign = [
    {
      id: 1,
      manifestPath: '/other/manifest.json',
      lastKnownPluginId: 'other-plugin',
      fileMetadata: { type: 'manifest', codeFileId: 2 },
    },
    {
      id: 2,
      manifestPath: '/other/code.js',
      fileMetadata: { type: 'code', manifestFileId: 1 },
    },
  ];
  f.write({
    windows: [{ path: '/design/Existing12' }],
    privateSetting: { preserve: true },
    localFileExtensions: foreign,
  });
  const before = fs.readFileSync(f.file);
  let checks = 0;
  const result = await registerDesktopPlugins(
    readRegistration({ home: f.home }),
    {
      assertStopped: async () => {
        checks++;
      },
    },
  );
  const saved = JSON.parse(fs.readFileSync(f.file));
  assert.deepEqual(saved.windows, [{ path: '/design/Existing12' }]);
  assert.deepEqual(saved.privateSetting, { preserve: true });
  assert.deepEqual(saved.localFileExtensions.slice(0, 2), foreign);
  assert.equal(new Set(saved.localFileExtensions.map((e) => e.id)).size, 5);
  assert.equal(checks, 2);
  assert(fs.readFileSync(result.settingsBackupPath).equals(before));
  assert.equal(fs.statSync(result.settingsBackupPath).mode & 0o777, 0o600);
  const after = fs.readFileSync(f.file);
  assert.equal(
    await registerDesktopPlugins(readRegistration({ home: f.home })),
    null,
  );
  assert(fs.readFileSync(f.file).equals(after));
});

test('obsolete owned registrations are replaced without keeping duplicate plugin IDs or touching foreign file metadata', async (t) => {
  const f = fixture(t),
    { pluginId } = profileInfo();
  f.write({
    localFileExtensions: [
      {
        id: 4,
        manifestPath: '/expired/manifest.json',
        lastKnownPluginId: pluginId,
        fileMetadata: { type: 'manifest', codeFileId: 5 },
      },
      {
        id: 5,
        manifestPath: '/expired/code.js',
        fileMetadata: { type: 'code', manifestFileId: 4 },
      },
      {
        id: 9,
        manifestPath: '/duplicate/manifest.json',
        lastKnownPluginId: pluginId,
      },
      {
        id: 40,
        manifestPath: '/unrelated/ui.html',
        fileMetadata: { type: 'ui', manifestFileId: 39 },
      },
    ],
  });
  await registerDesktopPlugins(readRegistration({ home: f.home }), {
    assertStopped: async () => {},
  });
  const entries = JSON.parse(fs.readFileSync(f.file)).localFileExtensions;
  assert.equal(
    entries.filter((e) => e.lastKnownPluginId === pluginId).length,
    1,
  );
  assert.equal(entries.find((e) => e.lastKnownPluginId === pluginId).id, 4);
  assert.equal(
    entries.find((e) => e.lastKnownPluginId === pluginId).manifestPath,
    profileInfo().manifestPath,
  );
  assert(
    !entries.some(
      (e) =>
        e.manifestPath.startsWith('/expired/') ||
        e.manifestPath.startsWith('/duplicate/'),
    ),
  );
  assert.deepEqual(entries.find((e) => e.id === 40).fileMetadata, {
    type: 'ui',
    manifestFileId: 39,
  });
});

test('registration refuses a running app, unknown settings schema and a concurrent settings change', async (t) => {
  const f = fixture(t);
  f.write({ windows: [], localFileExtensions: [] });
  const before = fs.readFileSync(f.file);
  await assert.rejects(
    registerDesktopPlugins(readRegistration({ home: f.home }), {
      assertStopped: async () => {
        throw Error('desktop_restart_required');
      },
    }),
    /desktop_restart_required/,
  );
  assert(fs.readFileSync(f.file).equals(before));
  f.write({ localFileExtensions: {} });
  assert.throws(
    () => readRegistration({ home: f.home }),
    /desktop_registration_schema_changed/,
  );
  f.write({ localFileExtensions: [] });
  let checks = 0;
  await assert.rejects(
    registerDesktopPlugins(readRegistration({ home: f.home }), {
      assertStopped: async () => {
        if (++checks === 2)
          f.write({ windows: ['new user state'], localFileExtensions: [] });
      },
    }),
    /desktop_registration_changed/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).windows, [
    'new user state',
  ]);
  assert(
    !fs.readdirSync(path.dirname(f.file)).some((name) => name.endsWith('.tmp')),
  );
});

test('a first-time Figma profile can register the stable manifests without a preexisting settings file', async (t) => {
  const f = fixture(t);
  const result = await registerDesktopPlugins(
    readRegistration({ home: f.home }),
    { assertStopped: async () => {} },
  );
  assert.equal(result.registered.length, 3);
  assert.equal(result.settingsBackupPath, undefined);
  assert.equal(readRegistration({ home: f.home }).changes.length, 0);
});

function downloadFixture(t, { accepted = true } = {}) {
  const f = fixture(t),
    calls = [];
  const app = path.join(f.home, 'Applications/Figma.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Contents/MacOS/DynamicUniversalApp'),
    'installer',
  );
  const execute = async (command, args) => {
    calls.push({ command, args });
    if (command.endsWith('/curl') && args.at(-1).endsWith('version.txt'))
      return { stdout: '126.11.8\n' };
    if (command.endsWith('/curl')) {
      fs.writeFileSync(args[args.indexOf('--output') + 1], 'download');
      return { stdout: '' };
    }
    if (command.endsWith('/ditto')) {
      const incoming = path.join(args.at(-1), 'Figma.app/Contents');
      fs.mkdirSync(path.join(incoming, 'MacOS'), { recursive: true });
      fs.writeFileSync(
        path.join(incoming, 'MacOS/Figma'),
        'complete application',
      );
      return { stdout: '' };
    }
    if (command.endsWith('/PlistBuddy'))
      return { stdout: 'com.figma.Desktop\n' };
    if (command.endsWith('/codesign')) {
      if (!accepted) throw Error('invalid vendor signature');
      return { stdout: '' };
    }
    assert.fail(command);
  };
  return { ...f, app, calls, execute };
}

test('installation chooses the official architecture-specific archive and replaces the whole bundle, retaining the previous one', async (t) => {
  const f = downloadFixture(t);
  const result = await installDesktopApp(f.app, {
    execute: f.execute,
    home: f.home,
    arch: 'arm64',
  });
  assert(
    f.calls.some(
      (c) =>
        c.args.at(-1) ===
        'https://desktop.figma.com/mac-arm/Figma-126.11.8.zip',
    ),
  );
  assert(
    f.calls.some(
      (c) =>
        c.command.endsWith('/codesign') &&
        c.args.includes('--deep') &&
        c.args.includes('--strict') &&
        c.args.includes('-R'),
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(result.app, 'Contents/MacOS/Figma'), 'utf8'),
    'complete application',
  );
  assert(
    !fs.existsSync(path.join(result.app, 'Contents/MacOS/DynamicUniversalApp')),
  );
  assert.equal(
    fs.readFileSync(
      path.join(result.previousAppPath, 'Contents/MacOS/DynamicUniversalApp'),
      'utf8',
    ),
    'installer',
  );
  assert.deepEqual(fs.readdirSync(path.dirname(result.previousAppPath)), [
    'previous.app',
  ]);
});

test('a failed download signature leaves the installed bundle intact', async (t) => {
  const f = downloadFixture(t, { accepted: false });
  await assert.rejects(
    installDesktopApp(f.app, { execute: f.execute, home: f.home }),
    /desktop_app_signature_invalid/,
  );
  assert(fs.existsSync(path.join(f.app, 'Contents/MacOS/DynamicUniversalApp')));
  assert(
    !fs
      .readdirSync(path.dirname(f.app))
      .some((s) => s.startsWith('.ysun-figma-')),
  );
});

test('an app restarted during download leaves the installed bundle intact', async (t) => {
  const valid = downloadFixture(t);
  await assert.rejects(
    installDesktopApp(valid.app, {
      execute: valid.execute,
      home: valid.home,
      assertStopped: async () => {
        throw Error('desktop_restart_required');
      },
    }),
    /desktop_restart_required/,
  );
  assert(
    fs.existsSync(path.join(valid.app, 'Contents/MacOS/DynamicUniversalApp')),
  );
});

test('an interrupted archive resumes its actual downloaded bytes without replacing the existing app', async (t) => {
  const f = downloadFixture(t);
  const http = require('node:http');
  const run = require('node:util').promisify(
    require('node:child_process').execFile,
  );
  const payload = Buffer.alloc(16384, 42),
    ranges = [];
  const server = http.createServer((req, res) => {
    ranges.push(req.headers.range || null);
    if (!req.headers.range) {
      res.writeHead(200, {
        'Content-Length': payload.length,
        Connection: 'close',
      });
      res.end(payload.subarray(0, 4096));
    } else {
      const offset = Number(req.headers.range.match(/bytes=(\d+)-/)[1]);
      res.writeHead(206, {
        'Content-Length': payload.length - offset,
        'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
      });
      res.end(payload.subarray(offset));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const execute = async (command, args, options) => {
    if (command.endsWith('/curl') && args.at(-1).endsWith('.zip')) {
      const redirected = [...args];
      redirected[redirected.length - 1] =
        `http://127.0.0.1:${server.address().port}/archive.zip`;
      return run(command, redirected, options);
    }
    return f.execute(command, args, options);
  };
  await assert.rejects(
    installDesktopApp(f.app, { execute, home: f.home, arch: 'arm64' }),
  );
  const archive = path.join(
    process.env.FIGMA_PLUGIN_STATE_DIR,
    'desktop/downloads/Figma-mac-arm-126.11.8.zip',
  );
  assert.equal(fs.statSync(archive).size, 4096);
  assert(fs.existsSync(path.join(f.app, 'Contents/MacOS/DynamicUniversalApp')));
  await installDesktopApp(f.app, { execute, home: f.home, arch: 'arm64' });
  assert.deepEqual(ranges, [null, 'bytes=4096-']);
  assert(!fs.existsSync(archive));
  assert(fs.existsSync(path.join(f.app, 'Contents/MacOS/Figma')));
});

test('an official stub is identified separately from a complete application', async () => {
  const info = await inspectApp('/fixture/Figma.app', async (command) => ({
    stdout: command.endsWith('/PlistBuddy') ? 'com.figma.Desktop.dua' : '',
  }));
  assert.equal(info.valid, true);
  assert.equal(info.complete, false);
});

test(
  'macOS accepts the actual publisher requirement as inline source rather than a filename',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = fixture(t);
    const run = require('node:util').promisify(
      require('node:child_process').execFile,
    );
    const result = await inspectApp(
      '/fixture/Figma.app',
      async (command, args) => {
        if (command.endsWith('/PlistBuddy'))
          return { stdout: 'com.figma.Desktop' };
        return run('/usr/bin/csreq', [
          '-r',
          args[args.indexOf('-R') + 1],
          '-b',
          path.join(f.root, 'requirement.bin'),
        ]);
      },
    );
    assert.equal(result.valid, true, result.signatureError?.message);
    assert(fs.statSync(path.join(f.root, 'requirement.bin')).size > 0);
  },
);

test('normal quit targets the observed PID and never escalates a cancelled quit', async () => {
  const calls = [];
  await assert.rejects(
    quitDesktop([{ pid: 42 }], {
      execute: async (command, args) => {
        calls.push({ command, args });
      },
      processes: async () => [{ pid: 42 }],
      timeoutMs: 0,
    }),
    /desktop_quit_pending/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/osascript');
  assert.equal(calls[0].args.at(-1), '42');
  assert(!calls[0].args.join(' ').includes('forceTerminate'));
});

test('Desktop discovery uses the system bundle index before requesting executable paths', async () => {
  const { desktopProcesses } = require('../src/host/desktop-app.cjs');
  const active = [
    { pid: 77, executable: '/Applications/Figma QA.app/Contents/MacOS/Figma' },
  ];
  const bundleIds = ['com.figma.Desktop', 'com.figma.Desktop.dua'];
  const commands = [];
  let matches = '';
  const execute = async (command, args) => {
    commands.push(command);
    if (command === '/usr/bin/lsappinfo') {
      assert.deepEqual(args, [
        '-nonames',
        ...bundleIds.flatMap((id) => ['find', 'bundleid=' + id]),
      ]);
      return { stdout: matches };
    }
    assert.equal(command, '/usr/bin/osascript');
    assert.deepEqual(args.slice(-2), bundleIds);
    return { stdout: JSON.stringify(active) };
  };
  assert.deepEqual(await desktopProcesses(execute), []);
  assert.deepEqual(commands, ['/usr/bin/lsappinfo']);
  matches = 'ASN:0x0-0x22022:';
  assert.deepEqual(await desktopProcesses(execute), active);
  await assert.rejects(
    desktopProcesses(async () => {
      throw Error('OS timeout');
    }),
    /desktop_process_query_unavailable/,
  );
});
test('backup references survive session replacement and stale session migration', (t) => {
  fixture(t);
  const { rememberBackups } = require('../src/host/desktop.cjs');
  const older = {
    previousAppPath: '/original.app',
    settingsBackupPath: '/first.json',
  };
  rememberBackups(older, true);
  rememberBackups({ settingsBackupPath: '/latest.json' });
  assert.deepEqual(rememberBackups(older, true), {
    ...older,
    settingsBackupPath: '/latest.json',
  });
  assert.deepEqual(rememberBackups(), {
    ...older,
    settingsBackupPath: '/latest.json',
  });
});
test('a retained archive uses the HTTP status and curl exit code for resume decisions', async (t) => {
  const f = downloadFixture(t),
    directory = path.join(
      process.env.FIGMA_PLUGIN_STATE_DIR,
      'desktop/downloads',
    );
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'Figma-mac-arm-126.11.8.zip');
  async function attempt(code, stdout, stderr) {
    fs.writeFileSync(file, 'retained-bytes');
    let requests = 0;
    const execute = async (command, args, options) => {
      if (command.endsWith('/curl') && args.at(-1).endsWith('.zip')) {
        requests++;
        if (requests === 1)
          throw Object.assign(Error('transfer'), { code, stdout, stderr });
        assert(!args.includes('--continue-at'));
      }
      return f.execute(command, args, options);
    };
    await installDesktopApp(f.app, { execute, home: f.home, arch: 'arm64' });
    return requests;
  }
  await assert.rejects(attempt(22, '502', 'trace 416'), /transfer/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'retained-bytes');
  assert.equal(await attempt(22, '416', 'localized message'), 1);
  assert.equal(await attempt(33, '200', 'range unsupported'), 2);
});
