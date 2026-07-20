import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pngToIco from 'png-to-ico';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'branding', 'rigorium', 'rigorium-mark.ico');
const sources = [
  resolve(root, 'branding', 'rigorium', 'rigorium-mark-16.png'),
  resolve(root, 'branding', 'rigorium', 'rigorium-mark-32.png'),
  resolve(root, 'branding', 'rigorium', 'rigorium-mark-256.png'),
];

await mkdir(dirname(output), { recursive: true });
await writeFile(output, await pngToIco(sources));
console.log(`Generated ${output}`);
