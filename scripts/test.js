'use strict';

// Run every suite in a fresh process, retaining SIM_ORDER and other options.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.js'))
  .sort();
const failures = [];

if (!tests.length) {
  console.error('No test suites found.');
  process.exitCode = 1;
} else {
  for (const name of tests) {
    console.log('\nRunning ' + name);
    const result = spawnSync(process.execPath, [path.join(root, 'tests', name)], {
      cwd: root,
      env: process.env,
      stdio: 'inherit'
    });
    if (result.error || result.signal || result.status !== 0) {
      const reason = result.error ? 'could not start' :
        result.signal ? 'signal ' + result.signal : 'exit ' + result.status;
      failures.push(name + ' (' + reason + ')');
    }
  }
  console.log('\nTest suites: ' + (tests.length - failures.length) + '/' + tests.length + ' passed.');
  if (failures.length) {
    console.error('Failed suites:\n' + failures.map(name => '  ' + name).join('\n'));
    process.exitCode = 1;
  }
}
