#!/usr/bin/env node
/**
 * Flip Electron security fuses on the packaged binary (Electron security
 * checklist #19): disable `nodeCliInspect` and force app loading from asar so
 * a compromised renderer cannot escalate via the inspect protocol or a loose
 * app path.
 *
 * `runAsNode` is intentionally LEFT ON: the packaged app spawns gateway/UI
 * child processes via `ELECTRON_RUN_AS_NODE` (desktop/main.mjs and
 * ui/server/utils/plugin-process-manager.js), which that fuse would block.
 * Fully disabling runAsNode requires moving those children to utilityProcess
 * first (tracked in docs/releases.md).
 *
 * Run AFTER `electron-builder --dir` produces the unpacked app and BEFORE the
 * NSIS installer is packaged from it (`--prepackaged`), so the hardening
 * actually lands inside the installer.
 */
import { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } from '@electron/fuses';
import { existsSync } from 'node:fs';

const candidates = [
  'release/win-unpacked/Rigorium.exe',
  'release/mac-arm64/Rigorium.app/Contents/MacOS/Rigorium',
  'release/mac-x64/Rigorium.app/Contents/MacOS/Rigorium',
];

const executable = candidates.find((candidate) => existsSync(candidate));
if (!executable) {
  // A missing binary means the build pipeline changed shape — fail loudly
  // instead of silently shipping an unhardened installer.
  console.error(`[fuses] no packaged executable found (looked in: ${candidates.join(', ')}).`);
  console.error('[fuses] run this after `electron-builder --dir` has produced the unpacked app.');
  process.exit(1);
}

await flipFuses(executable, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: true, // intentionally kept on — see header comment
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
});

// Assert the flip actually took effect on this exact binary (product-level
// verification — a no-op flip would otherwise go unnoticed).
// getCurrentFuseWire returns the raw fuse wire: one ASCII '0'/'1' char per
// fuse, indexed by FuseV1Options.
const wire = await getCurrentFuseWire(executable);
const fuseOn = (index) => String.fromCharCode(Number(wire[index])) === '1';
if (
  fuseOn(FuseV1Options.EnableNodeCliInspectArguments) !== false
  || fuseOn(FuseV1Options.OnlyLoadAppFromAsar) !== true
) {
  console.error('[fuses] verification failed after flipping — binary is not hardened as requested.');
  console.error(`[fuses] nodeCliInspect=${fuseOn(FuseV1Options.EnableNodeCliInspectArguments)} onlyLoadAppFromAsar=${fuseOn(FuseV1Options.OnlyLoadAppFromAsar)}`);
  process.exit(1);
}
console.log(`[fuses] hardened ${executable}`);
