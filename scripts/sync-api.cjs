// Development-only: check the canonical task index and official reference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  topics,
  workflows,
  indexRows,
} = require('../src/host/api-reference.cjs');
const directory = path.resolve(__dirname, '../skills/ysun-figma/references');
const sourceFile = path.join(directory, 'API-SOURCE.json');
const repository = 'https://github.com/figma/plugin-typings';
const referenceFile = 'plugin-api.d.ts';
const licenseFile = 'PLUGIN-API-LICENSE';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readSource() {
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  assert.equal(source.repository, repository, 'Unexpected API repository');
  assert.equal(source.file, referenceFile, 'Unexpected API reference file');
  assert.equal(source.licenseFile, licenseFile, 'Unexpected API license file');
  return source;
}

function checkLocal() {
  const source = readSource();
  const types = fs.readFileSync(path.join(directory, referenceFile), 'utf8');
  const declarations = types.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.equal(
    hash(types),
    source.sha256,
    'API reference differs from its pinned hash',
  );
  assert.ok(fs.existsSync(path.join(directory, licenseFile)));
  for (const [file] of Object.values(topics))
    assert.ok(
      fs.existsSync(path.resolve(directory, file)),
      'Missing topic: ' + file,
    );
  const tools = new Set(
    require('../src/host/mcp.cjs').tools.map((tool) => tool.name),
  );
  for (const [id, workflow] of Object.entries(workflows)) {
    assert.ok(
      workflow.when && fs.existsSync(workflow.path),
      'Invalid workflow: ' + id,
    );
    for (const tool of workflow.tools)
      assert.ok(tools.has(tool), 'Unknown workflow tool: ' + tool);
  }
  for (const [, , ids] of Object.values(topics))
    for (const id of ids)
      assert.ok(Object.hasOwn(workflows, id), 'Unknown workflow: ' + id);
  const symbols = new Set();
  for (const [topic, phrases, api] of indexRows('Features')) {
    assert.ok(Object.hasOwn(topics, topic), 'Unknown feature topic: ' + topic);
    assert.ok(phrases.trim(), 'A feature needs search phrases');
    for (const symbol of api.split(',').map((value) => value.trim())) {
      assert.ok(
        tools.has(symbol) ||
          new RegExp('\\b' + RegExp.escape(symbol) + '\\b').test(declarations),
        'Unknown indexed API/tool: ' + symbol,
      );
      symbols.add(symbol);
    }
  }
  const indexedTools = new Set([
    ...symbols,
    ...Object.values(workflows).flatMap((workflow) => workflow.tools),
  ]);
  for (const tool of tools)
    assert.ok(indexedTools.has(tool), 'Tool has no discovery route: ' + tool);
  return {
    topics: Object.keys(topics).length,
    workflows: Object.keys(workflows).length,
    features: indexRows('Features').length,
    symbols: symbols.size,
    source,
  };
}

async function refresh(update = false) {
  const current = readSource();
  // Public git transport avoids authenticated API quotas; no token or runtime dependency.
  const commit = execFileSync(
    'git',
    ['ls-remote', repository + '.git', 'HEAD'],
    { encoding: 'utf8', timeout: 30000 },
  ).split(/\s/)[0];
  assert.match(commit, /^[a-f0-9]{40}$/);
  const revision = encodeURIComponent(commit);
  const documentationUrl = 'https://developers.figma.com/docs/plugins/updates/';
  async function get(url) {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(
        'Official reference HTTP ' + response.status + ': ' + url,
      );
    return response.text();
  }
  const [types, license, html] = await Promise.all([
    get(
      `https://raw.githubusercontent.com/figma/plugin-typings/${revision}/${referenceFile}`,
    ),
    get(
      `https://raw.githubusercontent.com/figma/plugin-typings/${revision}/LICENSE`,
    ),
    get(documentationUrl),
  ]);
  assert.match(types, /interface PluginAPI/);
  assert.match(license, /MIT License/);
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)?.[1];
  assert.ok(article, 'Official update article was not found');
  const release = article.match(/Version 1, Update \d+/)?.[0];
  assert.ok(release, 'Official update version was not found');
  const text = article
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const documentation = { url: documentationUrl, release, sha256: hash(text) };
  const sha256 = hash(types);
  const changed =
    sha256 !== current.sha256 ||
    documentation.sha256 !== current.documentation?.sha256;
  if (update && changed) {
    fs.writeFileSync(path.join(directory, referenceFile), types);
    fs.writeFileSync(path.join(directory, licenseFile), license);
    fs.writeFileSync(
      sourceFile,
      JSON.stringify(
        {
          ...current,
          commit,
          sha256,
          retrieved: new Date().toISOString().slice(0, 10),
          documentation,
        },
        null,
        2,
      ) + '\n',
    );
  }
  const local = checkLocal();
  const result = {
    ...local,
    upstreamCommit: commit,
    release,
    changed,
    updated: update && changed,
  };
  if (changed && !update) {
    const error = new Error(
      'Official API types or release notes changed; review them and run npm run api:update',
    );
    error.result = result;
    throw error;
  }
  return result;
}

if (require.main === module)
  refresh(process.argv.includes('--update'))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.result || error.message);
      process.exitCode = 1;
    });
module.exports = { checkLocal, refresh };
