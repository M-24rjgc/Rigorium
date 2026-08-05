# Rigorium releases

Desktop releases are built from semantic version tags by `.github/workflows/windows-release.yml` and published to [M-24rjgc/Rigorium](https://github.com/M-24rjgc/Rigorium). The workflow produces a Windows x64 NSIS installer.

> **macOS**: the build-macos jobs are currently disabled while electron-builder 26.x
> packaging of the sharp native module on macOS is being resolved. To re-enable,
> restore the `build-macos` job and the `publish` job's macOS needs in
> `.github/workflows/windows-release.yml`.

1. Update `package.json` to the release version and commit it.
2. Create and push the matching tag, for example `v0.3.0`.
3. The Windows build job installs dependencies on a native runner and verifies the tag, updater contracts, desktop runtime, packaged metadata, native module architecture, and installer integrity.
4. A single publish job validates the dedicated SHA-256 file, creates an aggregate `SHA256SUMS.txt`, and creates or updates the GitHub Release.

## Build pipeline (Windows)

The Windows installer is built in three stages so security fuses are flipped
*before* the NSIS installer is packaged:

1. `pnpm run desktop:pack:win-unpacked` — `electron-builder --dir` produces
   `release/win-unpacked/` (unhardened; the packaged-runtime verification
   launches this binary via playwright, which needs Node CLI inspect support).
2. `pnpm run desktop:harden` — `scripts/flip-electron-fuses.mjs` flips fuses
   on the unpacked exe: `nodeCliInspect` off, `onlyLoadAppFromAsar` on, and
   verifies the flip with `readFuses`. `runAsNode` is intentionally left ON —
   the app spawns gateway/UI children via `ELECTRON_RUN_AS_NODE`; fully
   disabling it requires moving those children to `utilityProcess` first.
3. `pnpm run desktop:package:nsis` — `electron-builder --prepackaged
   release/win-unpacked` packages the NSIS installer from the hardened binary,
   so the shipped exe carries the fuses.

`pnpm run desktop:build` chains all three for local one-shot builds.

The packaged app records `GITHUB_REPOSITORY`, commit, version, build time, and channel in `dist/release-metadata.json`. The desktop updater uses that metadata, so public release builds do not require users to configure an update repository. A pre-release tag is published as a GitHub pre-release and is only selected by clients configured to include pre-releases.

The release repository is public. Private mirrors require an intentionally configured `GITHUB_TOKEN` in the desktop process so that both release metadata and installer downloads can be authenticated.

## Windows signing

For Authenticode signing, configure these repository Actions secrets:

- `WINDOWS_CSC_LINK`: base64-encoded PFX content or a certificate URL supported by electron-builder.
- `WINDOWS_CSC_KEY_PASSWORD`: PFX password.

> Note: fuses are flipped before NSIS packaging, so a signed installer is
> produced from the hardened binary. Windows is not currently signed.

## macOS

macOS builds are **disabled** (electron-builder 26.x packaging of the sharp
native module fails on macOS with `not a file` in the node-module collector).
To re-enable: restore the `build-macos` job and the `publish` job's macOS
needs in `.github/workflows/windows-release.yml`, and re-add the signing
secrets below.

For a Developer ID signed and notarized macOS release, configure all of these repository Actions secrets:

- `MACOS_CSC_LINK`: base64-encoded Developer ID Application certificate content or a certificate URL supported by electron-builder.
- `MACOS_CSC_KEY_PASSWORD`: certificate password.
- `APPLE_ID`: Apple Developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for the Apple account.
- `APPLE_TEAM_ID`: Apple Developer team identifier.

Every published installer has a dedicated `.sha256` asset. The updater refuses downloads that do not match that checksum.

## Local macOS build

Build on a Mac whose architecture matches the requested package:

```bash
pnpm install --frozen-lockfile
pnpm run desktop:build:mac -- --arm64  # Apple Silicon
# or: pnpm run desktop:build:mac -- --x64  # Intel Mac
```

Do not reuse `node_modules` across architectures. The installer is written to `release/` with the architecture in its filename.
