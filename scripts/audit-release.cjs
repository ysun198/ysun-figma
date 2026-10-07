const fs = require('node:fs');
const path = require('node:path');
const { publicEntries } = require('../src/host/installation.cjs');
const root = path.join(__dirname, '../build/plugin');

const patterns = [
  [
    'personal filesystem path',
    /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\)/i,
  ],
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bLTAI[A-Za-z0-9]{12,}\b/],
  [
    'service credential',
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  ],
  [
    'embedded credential',
    /["'](?:password|secret|api[_-]?key|access[_-]?token|session[_-]?token|admin[_-]?token)["']\s*:\s*["'][A-Za-z0-9_+/-]{16,}["']/i,
  ],
  // Design snapshots use "token" for semantic variable names; credentials
  // need a long value with digits rather than treating every design token as a key.
  [
    'embedded bearer token',
    /["']token["']\s*:\s*["'](?=[A-Za-z0-9_+/-]{32,}["'])(?=[A-Za-z0-9_+/-]*[0-9])[A-Za-z0-9_+/-]+["']/i,
  ],
];

function inspectPublicFiles(directory, files) {
  const allowed = JSON.parse(
    fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
  ).distributionFiles;
  for (const file of files) {
    const name = typeof file === 'string' ? file : file.path;
    const parts = name.split('/');
    if (
      parts.some((part) => part.startsWith('.') || part === 'node_modules') ||
      (!['README.md', 'package.json'].includes(name) &&
        !allowed.some((entry) =>
          entry.endsWith('/') ? name.startsWith(entry) : name === entry,
        ))
    ) {
      throw new Error(`Non-public file in release: ${name}`);
    }
    const absolute = path.join(directory, name);
    if (fs.lstatSync(absolute).isSymbolicLink())
      throw new Error(`Symlink in release: ${name}`);
    const content = fs.readFileSync(absolute, 'utf8');
    if (name.endsWith('.svg')) {
      const shapes = new Set([
        'svg',
        'g',
        'path',
        'rect',
        'circle',
        'ellipse',
        'line',
        'polyline',
        'polygon',
      ]);
      // Permit only literal sRGB colors in the self-contained theme rule.
      // Blending opaque colors preserves alpha when the host uses a mask.
      const color =
        '#[\\da-f]{6}|color-mix\\(in srgb,#[\\da-f]{6} (?:100|[1-9]?\\d)%,#[\\da-f]{6}\\)';
      const artwork = content.replace(
        new RegExp(
          `<style>:root\\{color:(?:${color})\\}@media\\(prefers-color-scheme:dark\\)\\{:root\\{color:(?:${color})\\}\\}<\\/style>`,
          'ig',
        ),
        '',
      );
      if (
        Buffer.byteLength(content) > 8192 ||
        !/^<svg\b[\s\S]*<\/svg>\s*$/.test(content) ||
        /<!|<\?|\bon[a-z]+\s*=|\b(?:href|src|style)\s*=|url\s*\(/i.test(
          content,
        ) ||
        [...artwork.matchAll(/<\/?([a-z][\w:.-]*)\b/gi)].some(
          (match) => !shapes.has(match[1]),
        )
      ) {
        throw new Error(
          `SVG must contain only static shapes, without metadata or external resources: ${name}`,
        );
      }
    }
    for (const [label, pattern] of patterns)
      if (pattern.test(content))
        throw new Error(
          `Public-content audit failed (${label}) in ${name}; matching content is not printed`,
        );
  }
  return files.length;
}

function auditRelease(directory = root) {
  const files = publicEntries(directory);
  return { files, count: inspectPublicFiles(directory, files) };
}
if (require.main === module) {
  try {
    const result = auditRelease();
    console.log(
      `Public-content audit passed · ${result.count} allowlisted files`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { auditRelease, inspectPublicFiles, patterns };
