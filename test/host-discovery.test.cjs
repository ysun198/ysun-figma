const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const test = require('node:test');
const codex = [
  '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
].find((p) => fs.existsSync(p));
test(
  'Codex itself parses the portable MCP server and packaged onboarding, without installing a fixture',
  { skip: !codex, timeout: 20000 },
  async (t) => {
    const root = require('../scripts/build.cjs').output,
      directory = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'figma-host-parse-')),
      );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const plugin = path.join(directory, 'current');
    for (const relative of require('../scripts/installation.cjs').publicEntries(
      root,
    )) {
      const target = path.join(plugin, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, relative), target);
    }
    const catalog = path.join(directory, '.agents/plugins/marketplace.json');
    fs.mkdirSync(path.dirname(catalog), { recursive: true });
    fs.writeFileSync(
      catalog,
      JSON.stringify({
        name: 'figma-parser-test',
        plugins: [
          {
            name: 'figma-plugin-local',
            source: { source: 'local', path: './current' },
          },
        ],
      }),
    );
    const child = spawn(codex, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    let buffer = '',
      stderr = '';
    const pending = new Map();
    child.stderr.on('data', (v) => {
      stderr += v;
    });
    child.stdout.on('data', (v) => {
      buffer += v;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (Object.hasOwn(m, 'id')) {
          pending.get(m.id)?.(m);
          pending.delete(m.id);
        }
      }
    });
    const call = (id, method, params) =>
      new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    const init = await call(1, 'initialize', {
      clientInfo: { name: 'figma-plugin-test', version: '1' },
      capabilities: { experimentalApi: true },
    });
    assert(!init.error);
    child.stdin.write('{"method":"initialized"}\n');
    const response = await call(2, 'plugin/read', {
      marketplacePath: catalog,
      pluginName: 'figma-plugin-local',
    });
    assert(!response.error, JSON.stringify(response.error));
    assert.deepEqual(response.result.plugin.mcpServers, ['figma-local']);
    const presentation = response.result.plugin.summary.interface;
    assert.equal(
      presentation.displayName,
      require('../plugin.json').extensions['com.openai'].interface.displayName,
    );
    // The actual host drops logoDarkUrl in one tool-record fallback branch.
    // That consumer must work from the same self-themed primary image alone.
    const icon = fs.readFileSync(path.join(__dirname, '../assets/icon.svg'));
    const hash = require('node:crypto')
      .createHash('sha256')
      .update(icon)
      .digest('hex');
    const iconName = 'icon-' + hash + '.svg';
    assert.deepEqual(
      fs.readdirSync(path.join(plugin, 'assets')),
      [iconName],
      'ship one immutable icon; no duplicate or old assets',
    );
    assert.equal(
      presentation.composerIcon,
      path.join(plugin, 'assets', iconName),
    );
    assert.equal(presentation.logo, presentation.composerIcon);
    assert.deepEqual(fs.readFileSync(presentation.composerIcon), icon);
    assert.equal(presentation.logoDark, null);
    assert(!fs.existsSync(path.join(plugin, 'assets/icon-dark.svg')));
    // An uninstalled fixture has no enabled onboarding action. Its skill must
    // still be discovered; the installed package is accepted separately.
    assert.deepEqual(response.result.plugin.skills.map((s) => s.name).sort(), [
      'figma-plugin-local:ysun-figma',
      'figma-plugin-local:ysun-figma-create-design',
      'figma-plugin-local:ysun-figma-design-system',
      'figma-plugin-local:ysun-figma-design-to-code',
      'figma-plugin-local:ysun-figma-figjam',
      'figma-plugin-local:ysun-figma-files',
      'figma-plugin-local:ysun-figma-motion',
      'figma-plugin-local:ysun-figma-prototype',
      'figma-plugin-local:ysun-figma-slides',
    ]);
    assert(response.result.plugin.skills.every((s) => s.enabled));
    assert.doesNotMatch(
      stderr,
      /unknown field[^\n]*skills|skills[^\n]*unknown field/i,
    );
    assert(
      !/failed to parse plugin MCP server/.test(stderr),
      'the actual loader must accept the launch command',
    );
  },
);
