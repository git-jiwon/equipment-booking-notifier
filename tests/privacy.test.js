'use strict';

// This publication guard detects common identifiers and secrets in public files.
// Real names, room labels, affiliation and contextual identifiers still need review.
// Reports intentionally contain only relative filenames, categories and line numbers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function allowedAddress(address) {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();
  if (/^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/.test(domain)) return true;
  return domain === ['group', 'calendar', 'google', 'com'].join('.') &&
    /^example-[a-z0-9-]+$/i.test(local);
}

function placeholder(value) {
  return /^(?:<?(?:your|example|placeholder|change[-_]?me|replace)[a-z0-9_ <>.\/-]*>?|\*+|x+|\$\{[^}]+\})$/i.test(value);
}

function findings(text) {
  const hits = [];
  const add = (category, index) => {
    const line = text.slice(0, index).split('\n').length;
    if (!hits.some(hit => hit.category === category && hit.line === line)) {
      hits.push({ category, line });
    }
  };
  const scan = (expression, category, reject = () => true) => {
    for (const match of text.matchAll(expression)) {
      if (reject(match)) add(category, match.index);
    }
  };

  scan(/[a-z0-9.!#$%&*+/=?^_{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi,
    'non-example email or calendar ID', match => !allowedAddress(match[0]));
  scan(/(?:^|[\s"'`=(])(?:[a-z]:[\\/]+|\\\\[a-z0-9._-]+[\\/])[^\\/\r\n"'`<>|:*?]+/gim,
    'absolute Windows path');
  scan(/-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----/g, 'private key');
  scan(/(?:gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{40,}|AIza[a-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|sk-(?:proj-|live-|test-)?[a-z0-9_-]{24,}|xox[baprs]-[a-z0-9-]{20,})/gi,
    'provider credential');
  scan(/eyJ[a-z0-9_-]{12,}\.[a-z0-9_-]{12,}\.[a-z0-9_-]{12,}/gi, 'JSON web token');
  scan(/\b(?:api[_-]?key|secret[_-]?key|password|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi,
    'credential assignment', match => !placeholder(match[1]));
  scan(/\b[a-z0-9_+\/-]{48,}={0,2}/gi, 'long token', match => {
    const value = match[0];
    if (placeholder(value)) return false;
    if (/^[a-f0-9]{64,}$/i.test(value)) return true;
    return /[a-z]/i.test(value) && /\d/.test(value);
  });
  return hits;
}

// Synthetic probes are assembled at runtime so the guard can scan its own source.
assert.equal(findings('admin@example.com example-afm@calendar.example.com').length, 0);
assert.equal(findings(['example-test', ['group', 'calendar', 'google', 'com'].join('.')].join('@')).length, 0);
assert.equal(findings("'" + ['example-test', ['group', 'calendar', 'google', 'com'].join('.')].join('@') + "'").length, 0);
assert(findings(['participant', ['invalid', 'test'].join('.')].join('@')).length > 0);
assert(findings(['Z:', 'Users', 'sample'].join(String.fromCharCode(92))).length > 0);
assert(findings('-----' + ['BEGIN', 'PRIVATE', 'KEY'].join(' ') + '-----').length > 0);
assert(findings(['gh', 'p', '_'].join('') + 'A'.repeat(36)).length > 0);
assert(findings('Aa0_'.repeat(20)).length > 0);
assert(findings('ab0_'.repeat(20)).length > 0);
assert(findings('f'.repeat(64) + '@' + ['group', 'calendar', 'google', 'com'].join('.')).length > 0);
assert(findings('client' + '_secret = "' + 'Aa0'.repeat(12) + '"').length > 0);

function publicFiles() {
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
  });
  if (gitRoot.status === 0 && path.resolve(gitRoot.stdout.trim()).toLowerCase() === root.toLowerCase()) {
    const listed = spawnSync('git', ['ls-files', '--cached', '-z'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024
    });
    if (listed.error || listed.status !== 0) throw new Error('Could not enumerate tracked files.');
    const files = listed.stdout.split('\0').filter(Boolean);
    if (files.length) return { mode: 'Git tracked files', files };
  }

  // Before the initial commit, inspect only known publication directories/files.
  // Local credentials and operating data must stay outside this allowlist.
  const files = [];
  const extensions = new Set(['.gs', '.js', '.json', '.md', '.yml', '.yaml', '.txt', '.html', '.css']);
  const walk = relative => {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name.startsWith('.') || /^(?:node_modules|local|private|credentials|coverage|dist)$/i.test(item.name)) continue;
      const file = path.join(relative, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile() && extensions.has(path.extname(item.name).toLowerCase()) && !/\.local\./i.test(item.name)) files.push(file);
    }
  };
  ['src', 'tests', 'docs', 'scripts'].forEach(walk);
  ['README.md', 'SECURITY.md', 'LICENSE', 'package.json', 'package-lock.json', '.gitignore']
    .filter(file => fs.existsSync(path.join(root, file))).forEach(file => files.push(file));
  return { mode: 'pre-commit publication allowlist', files };
}

let failures = 0;
try {
  const selection = publicFiles();
  for (const relative of [...new Set(selection.files)].sort()) {
    const absolute = path.resolve(root, relative);
    const display = path.relative(root, absolute).split(path.sep).join('/');
    if (display === '..' || display.startsWith('../') || display.split('/').includes('.git')) {
      console.error('FAIL publication manifest: invalid relative filename');
      failures++;
      continue;
    }
    // A tracked deletion will not be published; symbolic links require manual review.
    if (!fs.existsSync(absolute)) continue;
    if (!fs.lstatSync(absolute).isFile()) {
      console.error('FAIL ' + display + ': manual review required for non-regular file');
      failures++;
      continue;
    }
    for (const hit of findings(fs.readFileSync(absolute, 'utf8'))) {
      console.error('FAIL ' + display + ':' + hit.line + ' [' + hit.category + ']');
      failures++;
    }
  }
  if (!failures) console.log('Privacy guard passed (' + selection.mode + ', ' + selection.files.length + ' files).');
} catch (_) {
  console.error('FAIL privacy guard: could not read the publication file list or a selected file');
  failures++;
}
if (failures) {
  console.error('Privacy guard found ' + failures + ' issue(s); matched values are withheld.');
  process.exitCode = 1;
}
