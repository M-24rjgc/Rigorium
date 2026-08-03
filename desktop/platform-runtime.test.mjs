import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { macOSCommandPath, packagedEsbuildBinaryPath } from './platform-runtime.mjs';

test('packaged esbuild paths match each desktop platform layout', () => {
  assert.equal(
    packagedEsbuildBinaryPath('/resources', 'darwin', 'arm64'),
    join('/resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'),
  );
  assert.equal(
    packagedEsbuildBinaryPath('/resources', 'darwin', 'x64'),
    join('/resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'darwin-x64', 'bin', 'esbuild'),
  );
  assert.equal(
    packagedEsbuildBinaryPath('C:\\resources', 'win32', 'x64'),
    join('C:\\resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
  );
});

test('macOS command path preserves configured entries and adds common package-manager locations once', () => {
  const commandPath = macOSCommandPath('/custom/bin:/usr/bin:/opt/homebrew/bin', '/Users/researcher');
  assert.deepEqual(commandPath.split(':'), [
    '/custom/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/Users/researcher/.local/bin',
  ]);
});
