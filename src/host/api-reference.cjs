// Offline discovery of the pinned public API and task-specific native recipes.
const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(__dirname, '../../skills/ysun-figma/references');
function indexRows(section) {
  return fs
    .readFileSync(path.join(directory, 'api-map.md'), 'utf8')
    .split('## ' + section + '\n')[1]
    .split('\n## ')[0]
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim().replaceAll('`', '')),
    );
}
const topics = Object.fromEntries(
  indexRows('Topics').map(([id, link, description, workflow]) => [
    id,
    [
      link.match(/\]\(([^)]+)\)/)[1],
      description,
      workflow.split(',').map((s) => s.trim()),
    ],
  ]),
);
const workflows = Object.fromEntries(
  indexRows('Workflows').map(([id, when, tools, guide]) => [
    id,
    {
      when,
      tools: tools.split(',').map((s) => s.trim()),
      path: path.resolve(directory, guide.match(/\]\(([^)]+)\)/)[1]),
    },
  ]),
);
const featureRows = indexRows('Features');
const source = JSON.parse(
  fs.readFileSync(path.join(directory, 'API-SOURCE.json'), 'utf8'),
);
const reference = { ...source, path: path.join(directory, source.file) };
let declarations;
function matchingLines(term) {
  if (!declarations) {
    const lines = fs.readFileSync(reference.path, 'utf8').split('\n');
    let owner = 'Global API';
    declarations = {
      lines,
      entries: lines.map((text, i) => {
        const declaration = text.match(/^(?:interface|type|enum)\s+(\w+)/);
        if (declaration) owner = declaration[1];
        return {
          i,
          owner,
          lower: text.toLowerCase(),
          declaration: declaration?.[1].toLowerCase(),
          code: !/^(?:\*|\/\/|\/\*)/.test(text.trim()),
        };
      }),
    };
  }
  const needle = term.toLowerCase();
  const exact = new RegExp(
    '(?:^|[^\\w$])' +
      term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '(?:$|[^\\w$])',
    'i',
  );
  return declarations.entries
    .filter((row) => row.lower.includes(needle))
    .map((row) => ({
      i: row.i,
      owner: row.owner,
      symbol: term,
      score:
        (row.code ? 4 : 0) +
        (exact.test(declarations.lines[row.i]) ? 2 : 0) +
        (row.declaration === needle ? 8 : 0),
    }));
}
function findFeatures(query, limit) {
  const needle = query.trim().toLowerCase();
  return featureRows
    .map(([topic, phrases, symbols]) => {
      const terms = [...phrases.split(';'), ...symbols.split(',')].map((s) =>
        s.trim(),
      );
      const score = Math.max(
        0,
        ...terms
          .map((term) => term.toLowerCase())
          .filter((term) => needle.includes(term) || term.includes(needle))
          .map((term) => Math.min(term.length, needle.length)),
      );
      return {
        score,
        topic,
        task: terms[0],
        symbols: symbols.split(',').map((s) => s.trim()),
        path: path.resolve(directory, topics[topic][0]),
        workflows: topics[topic][2],
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...entry }) => entry);
}
function readAPIReference({ query, topic, workflow, limit = 5 } = {}) {
  if (topic && (query || workflow))
    throw new Error('Choose an API query/workflow or a topic');
  if (workflow && !Object.hasOwn(workflows, workflow))
    throw new Error('Unknown workflow');
  const selected = workflow
    ? {
        workflow: {
          id: workflow,
          ...workflows[workflow],
          text: fs.readFileSync(workflows[workflow].path, 'utf8'),
        },
      }
    : {};
  const availableTopics = Object.entries(topics)
    .filter(([, value]) => !workflow || value[2].includes(workflow))
    .map(([id, [file, description]]) => ({
      id,
      description,
      path: path.join(directory, file),
    }));
  if (topic) {
    if (!Object.hasOwn(topics, topic)) throw new Error('Unknown API topic');
    const [file, description, workflowIds] = topics[topic];
    return {
      reference,
      topic,
      description,
      workflows: workflowIds.map((id) => ({ id, ...workflows[id] })),
      path: path.join(directory, file),
      text: fs.readFileSync(path.join(directory, file), 'utf8'),
    };
  }
  if (!query)
    return {
      reference,
      ...selected,
      ...(!workflow
        ? {
            workflows: Object.entries(workflows).map(([id, entry]) => ({
              id,
              ...entry,
            })),
          }
        : {}),
      topics: availableTopics,
      runtimeAvailability:
        'Declarations describe the API, not editor support or plan permission. Use figma_capabilities for the connected target.',
    };
  // Accept a native path as well as the declaration name used in the typings.
  const term = query.trim().split('.').at(-1);
  if (!term) throw new Error('Choose a non-empty API symbol or phrase');
  const features = findFeatures(query, limit);
  let matches = matchingLines(term);
  const resolvedSymbols = matches.length
    ? []
    : [...new Set(features.flatMap((feature) => feature.symbols))].slice(0, 12);
  if (resolvedSymbols.length) matches = resolvedSymbols.flatMap(matchingLines);
  const lines = declarations.lines;
  matches.sort((a, b) => b.score - a.score || a.i - b.i);
  const excerpts = [],
    used = new Set();
  let remaining = 12000;
  for (const match of matches) {
    if (used.has(match.i)) continue;
    let start = match.i;
    // Include the immediately preceding documentation without returning a type-sized manual.
    if (lines[start - 1]?.trim() === '*/') {
      let j = start - 2;
      while (j >= 0 && start - j < 60 && lines[j].trim() !== '/**') j--;
      if (lines[j]?.trim() === '/**') start = j;
    } else start = Math.max(0, start - 2);
    let end = Math.min(lines.length, match.i + 13);
    const originalStart = start,
      originalEnd = end;
    const length = Math.min(5000, remaining);
    let text = lines.slice(start, end).join('\n');
    // Keep the matched declaration visible even when its preceding JSDoc is long.
    while (text.length > length && start < match.i)
      text = lines.slice(++start, end).join('\n');
    while (text.length > length && end > match.i + 1)
      text = lines.slice(start, --end).join('\n');
    for (let j = start; j < end; j++) used.add(j);
    excerpts.push({
      ...(resolvedSymbols.length ? { symbol: match.symbol } : {}),
      owner: match.owner,
      line: match.i + 1,
      startLine: start + 1,
      endLine: end,
      text: text.slice(0, length),
      truncated:
        start !== originalStart || end !== originalEnd || text.length > length,
    });
    remaining -= Math.min(text.length, length);
    if (excerpts.length === limit || remaining < 1000) break;
  }
  return {
    reference,
    ...selected,
    query,
    symbol: term,
    features,
    ...(resolvedSymbols.length ? { resolvedSymbols } : {}),
    totalMatchingLines: matches.length,
    excerpts,
    truncated:
      excerpts.some((e) => e.truncated) || matches.some((m) => !used.has(m.i)),
    ...(!features.length && !matches.length
      ? {
          topics: availableTopics,
          next: 'No literal match is not an unsupported-feature result. Translate the task into the returned native concepts, read the relevant topic/workflow, then query its exact API symbols; do not ask the user to name a Figma feature.',
        }
      : {}),
    runtimeAvailability:
      'Not probed. Use figma_capabilities and the real operation before assuming availability.',
  };
}
module.exports = { readAPIReference, topics, workflows, indexRows };
