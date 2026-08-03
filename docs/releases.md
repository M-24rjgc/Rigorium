# Rigorium releases

Desktop releases are built from semantic version tags by `.github/workflows/windows-release.yml` and published to [M-24rjgc/Rigorium](https://github.com/M-24rjgc/Rigorium). The workflow produces a Windows x64 NSIS installer plus separate macOS DMGs for Apple Silicon and Intel Macs.

1. Update `package.json` to the release version and commit it.
2. Create and push the matching tag, for example `v0.2.2`.
3. Windows, macOS arm64, and macOS x64 build jobs install dependencies on native runners and verify the tag, updater contracts, desktop runtime, packaged metadata, native module architecture, and installer integrity.
4. A single publish job validates every dedicated SHA-256 file, creates an aggregate `SHA256SUMS.txt`, and creates or updates the GitHub Release only after all three builds pass.

The packaged app records `GITHUB_REPOSITORY`, commit, version, build time, and channel in `dist/release-metadata.json`. The desktop updater uses that metadata, so public release builds do not require users to configure an update repository. A pre-release tag is published as a GitHub pre-release and is only selected by clients configured to include pre-releases.

The release repository is public. Private mirrors require an intentionally configured `GITHUB_TOKEN` in the desktop process so that both release metadata and installer downloads can be authenticated.

## Windows signing

For Authenticode signing, configure these repository Actions secrets:

- `WINDOWS_CSC_LINK`: base64-encoded PFX content or a certificate URL supported by electron-builder.
- `WINDOWS_CSC_KEY_PASSWORD`: PFX password.

## macOS signing and notarization

For a Developer ID signed and notarized macOS release, configure all of these repository Actions secrets:

- `MACOS_CSC_LINK`: base64-encoded Developer ID Application certificate content or a certificate URL supported by electron-builder.
- `MACOS_CSC_KEY_PASSWORD`: certificate password.
- `APPLE_ID`: Apple Developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for the Apple account.
- `APPLE_TEAM_ID`: Apple Developer team identifier.

The workflow fails on a partial signing configuration. When signing is enabled it verifies the application with `codesign`; when notarization credentials are also present it validates the stapled ticket and runs a Gatekeeper assessment. Unsigned macOS builds remain available as workflow artifacts for internal testing, but the publish job requires all signing and notarization secrets before it updates the public GitHub Release.

Every published installer has a dedicated `.sha256` asset. The updater refuses downloads that do not match that checksum.

## Local macOS build

Build on a Mac whose architecture matches the requested package:

```bash
pnpm install --frozen-lockfile
pnpm run desktop:build:mac -- --arm64  # Apple Silicon
# or: pnpm run desktop:build:mac -- --x64  # Intel Mac
```

Do not reuse `node_modules` across architectures. The installer is written to `release/` with the architecture in its filename.
