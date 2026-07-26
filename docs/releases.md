# Rigorium releases

Windows releases are built from semantic version tags by `.github/workflows/windows-release.yml` and published to [M-24rjgc/Rigorium](https://github.com/M-24rjgc/Rigorium).

1. Update `package.json` to the release version and commit it.
2. Create and push the matching tag, for example `v0.1.0`.
3. The workflow validates the tag, runs the updater backend suite, the focused update-notifier UI test, the root TypeScript check, and the production UI build. It then builds the NSIS installer, verifies release metadata inside `app.asar`, verifies the packaged research runtime, and publishes the installer, block map, and SHA-256 files to GitHub Releases.

The packaged app records `GITHUB_REPOSITORY`, commit, version, build time, and channel in `dist/release-metadata.json`. The desktop updater uses that metadata, so public release builds do not require users to configure an update repository. A pre-release tag is published as a GitHub pre-release and is only selected by clients configured to include pre-releases.

The release repository is public. Private mirrors require an intentionally configured `GITHUB_TOKEN` in the desktop process so that both release metadata and installer downloads can be authenticated.

For Authenticode signing, configure these repository Actions secrets:

- `WINDOWS_CSC_LINK`: base64-encoded PFX content or a certificate URL supported by electron-builder.
- `WINDOWS_CSC_KEY_PASSWORD`: PFX password.

Unsigned builds remain installable but can trigger Windows SmartScreen. Every published installer is independently protected by a release SHA-256 asset, and the updater refuses unverified downloads.
