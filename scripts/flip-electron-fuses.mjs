#!/usr/bin/env node
/**
 * Flip Electron security fuses on the packaged binary (Electron security
 * checklist #19): disable `runAsNode` and `nodeCliInspect` so a compromised
 * renderer cannot escalate via Node-mode execution or the inspect protocol.
 * Runs after electron-builder produces the unpacked app.
 */
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const candidates = [
  'release/win-unpacked/Rigorium.exe',
  'release/mac-arm64/Rigorium.app/Contents/MacOS/Rigorium',
  'release/mac-x64/Rigorium.app/Contents/MacOS/Rigorium',
];

const executable = candidates.find((candidate) => existsSync(candidate));
if (!executable) {
  console.warn('[fuses] no packaged executable found — skipping (run after electron-builder).');
  process.exit(0);
}

await flipFuses(executable, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
});
console.log(`[fuses] hardened ${executable}`);
