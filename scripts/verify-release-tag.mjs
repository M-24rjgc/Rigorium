import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
const tag = String(process.argv[2] || process.env.GITHUB_REF_NAME || '').trim();

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) {
  throw new Error(`Release tag must be semantic and start with v; received ${tag || '<empty>'}.`);
}

const tagVersion = tag.slice(1);
if (tagVersion !== packageJson.version) {
  throw new Error(`Release tag ${tag} does not match package.json version ${packageJson.version}.`);
}

console.log(JSON.stringify({ tag, version: packageJson.version, valid: true }));
