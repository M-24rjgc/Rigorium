import { rebuild } from '@electron/rebuild';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version: electronVersion } = require('electron/package.json');

await rebuild({
  buildPath: projectRoot,
  electronVersion,
  arch: process.arch,
  onlyModules: ['better-sqlite3'],
  force: true,
});

console.info(`Rebuilt better-sqlite3 for Electron ${electronVersion} (${process.arch}).`);
