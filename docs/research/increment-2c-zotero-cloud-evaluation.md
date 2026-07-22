# Research literature increment 2C: Zotero cloud credentials and guarded writes

Date verified: 2026-07-22

This record covers the opt-in cloud path for Zotero tags and notes. It is separate from the key-free Local API read path documented in increments 2A and 2B. Zotero remains the source of truth; Rigorium does not import, mirror, or modify Zotero SQLite databases.

## Decision

- Use the official Zotero Web API v3 for authenticated user or group libraries.
- Keep the API key outside the renderer, settings JSON, project files, server logs, and UI-server environment.
- Persist only encrypted credential material in Electron application data through `safeStorage`; the renderer receives a status result, never a key.
- Make every mutation a two-step operation: produce a reviewed plan, then perform it only after explicit confirmation.
- Use Zotero library and item versions as write preconditions. A conflict becomes an inspectable result, not an automatic overwrite.
- Keep Local API reads and the cloud path independently available. Missing cloud credentials must not break collection browsing, item detail, full text, or citation export.

## Official Zotero Web API v3 basis

- Zotero documents v3 as the recommended production version and recommends sending `Zotero-API-Version: 3`. The public service base URL is `https://api.zotero.org`; the desktop Local API remains a separate, key-free `http://localhost:23119/api/` read path.
- Public-library reads need no authentication. Private-library access requires an API key; Zotero recommends OAuth or a dedicated user key for third-party services. This implementation uses a user-supplied dedicated key and does not request OAuth scopes from a Rigorium service.
- A `Last-Modified-Version` response is a monotonic version marker. `If-Unmodified-Since-Version` protects a mutation, while `If-Modified-Since-Version` supports incremental sync reads. Multi-object endpoints use a library version; single-item endpoints use an item version.
- Zotero documents `412 Precondition Failed` when an `If-Unmodified-Since-Version` value is stale. A locked library is a distinct `409 Conflict` case. The API supports a one-use `Zotero-Write-Token`, but this increment uses version preconditions because the reviewed plan already contains the observed version.

Primary references:

- <https://www.zotero.org/support/dev/web_api/v3/basics>
- <https://www.zotero.org/support/dev/web_api/v3/write_requests>
- <https://www.zotero.org/support/dev/web_api/v3/syncing>

## Credential and process boundary

- The sandbox-compatible CommonJS preload exposes only `status`, `save`, and `clear` operations for cloud credentials, guarded cloud status/sync/preview/confirm methods, and an explicit local-library import method. It does not expose a stored key, broker URL, route token, or broker capability token to web content.
- The main process validates the supplied key, encrypts it with Electron `safeStorage`, and stores a versioned ciphertext envelope under the application's user-data directory. `status` reports only whether secure storage is available and whether a key is configured.
- The local broker is loopback-only, accepts a random bearer capability, constrains relative paths to `api.zotero.org`, allows a small header and method set, bounds request and response bodies, and redacts the stored key from a returned body.
- The UI server consumes private desktop capabilities through a one-time Electron child-process IPC handshake rather than inheriting them through its environment. The renderer invokes the preload boundary; it cannot call cloud routes or the desktop local-import route directly over HTTP.
- The main window rejects navigation to API and project-preview documents. IPC handlers additionally require the top-level main frame and a non-API application URL, while each preload call repeats the document check.
- On Windows, Electron documents `safeStorage` as using DPAPI. This protects data from other users on the same machine, but not from other applications running as the same Windows user. The product therefore also limits which local process can request a cloud operation and never treats ciphertext as a portable secret.

Electron reference: <https://www.electronjs.org/docs/latest/api/safe-storage>

## Concurrency and conflict protocol

1. Read `/keys/current` and the configured library version before producing a plan.
2. Read the target item before a tag or note plan so the plan records its item version and the relevant before-state.
3. Cache the reviewed plan for a short TTL and make it one-shot. The confirm request uses the cached copy, so a client cannot alter a reviewed plan between preview and execution.
4. Send `If-Unmodified-Since-Version` on `POST`, `PATCH`, and `DELETE` requests. Parse `Last-Modified-Version`, `Retry-After`, and `Backoff` when Zotero returns them.
5. For additive or subtractive tag changes, a `412` triggers one fresh read and one safe rebase retry. A replacement is never rebased after the remote tag set changed.
6. For note updates and deletions, a `412` returns a conflict containing the base, local, and, when readable, remote content. It does not overwrite or retry the note automatically.
7. A failed, expired, unknown, rate-limited, locked, or partially successful plan is returned as data for the caller to review. Replaying a prior plan is not supported.

The implementation is in `src/research/library/zoteroCloudProvider.ts`; HTTP route validation is in `ui/server/routes/research.js`; the browser-facing types and explicit preview UI are in `ui/src/research`.

## Sources, licenses, and reuse decision

### Official Zotero service and source

- Zotero Web API documentation is the selected protocol source. The application calls the documented HTTP contract; no Zotero application source code is copied or bundled.
- Zotero's upstream `COPYING` states that Zotero source is distributed under AGPLv3 and also identifies the Zotero trademark. Because no Zotero source or branding is adopted, this integration does not vendor that code or represent itself as Zotero.
- Source: <https://github.com/zotero/zotero/blob/main/COPYING>

### `@oscardvs/zoteus` 1.0.4 - retained as a reference, not embedded

- npm metadata checked on this date reports MIT, Node `>=20.19`, and an unpacked size of 580,112 bytes. Its public description covers Web API v3, Local API, safe writes, citations, and semantic features.
- The project is a useful behavioral reference for version-aware cloud writes, but embedding its MCP server would duplicate Rigorium's provider, desktop credential boundary, route contracts, and MCP orchestration.
- No Zoteus code is copied. Re-evaluate a pinned upstream release only if later work needs its capabilities as a user-configurable MCP rather than as a hidden desktop dependency.
- Sources: <https://www.npmjs.com/package/@oscardvs/zoteus>, <https://github.com/oscardvs/zoteus>

### Community MCP servers and Zotero XPI servers - not bundled

- `54yyyu/zotero-mcp` is MIT-licensed and remains a candidate optional MCP. It introduces a Python runtime and its own dependency and lifecycle surface, which is disproportionate for the deterministic desktop cloud path.
- `cookjohn/zotero-mcp` is MIT-licensed and exposes deeper Zotero-side functionality through an installable XPI. Requiring a separate extension installation, port, permissions, and version-compatibility lifecycle would make the base Windows package less predictable.
- Neither implementation is vendored, launched automatically, or treated as required infrastructure. A future user-configurable integration must be pinned, license-checked again, tested against the supported Zotero version, and isolated from the desktop startup path.
- Sources: <https://github.com/54yyyu/zotero-mcp>, <https://github.com/cookjohn/zotero-mcp>

### Attachment uploads - deliberately excluded

- Zotero's official upload flow is a separate attachment lifecycle: obtain item metadata, request upload authorization with size, name, hash, and modification time, transfer data to the authorized storage target, and register or verify the upload.
- This increment handles only metadata tags and notes. It does not upload attachment bytes, read local attachment paths, or infer a user's consent to place files in Zotero storage.
- Deferral avoids shipping untested resumability, binary-diff handling, hashing, quota, cancellation, recovery, and data-ownership UX in the first authenticated write slice.
- Source: <https://www.zotero.org/support/dev/web_api/v3/file_upload>

## Actual adopted surface

- `zotero.cloud` settings select an opt-in user or group library without storing the API key.
- Electron main-process credential storage, a constrained loopback broker, private main-to-server route authorization, and a narrow preload contract provide the desktop security boundary.
- `ZoteroCloudProvider` supports status, incremental version probing, tag plans, note create/update/delete plans, explicit confirmation, bounded retry, and conflict results.
- The research panel exposes a preview before a cloud mutation and presents success, partial, and conflict outcomes without silently modifying Zotero.
- Local Zotero Collection binding, item detail, full text, and exports remain read-oriented and continue to work without a cloud credential.

## Windows packaging and verification evidence

- `electron-builder` includes `desktop/**/*`, `dist/**/*`, UI output, UI server files, and the package manifest in the Windows artifact. The packaged window uses context isolation, sandboxing, and the preload bridge.
- The packaging verifier uses a fresh temporary user-data directory, a local mock broker, and a local Connector mock. It does not require a running Zotero desktop, a network connection, or a real API key.
- The verifier checks the preload `status`/`save`/`clear` contract, confirms that the temporary credential record is encrypted rather than plaintext, verifies clear confirmation, and ensures the test value never reaches the DOM or desktop log.
- It rejects direct renderer HTTP access, exercises cloud write preview and confirm through the packaged IPC and broker boundary, and exercises local-library import through the guarded preload/main-process path.
- Verification command: `pnpm desktop:verify-research`. The command is run after a packaged build exists at `release/win-unpacked/Rigorium.exe`; the result and observed request evidence are recorded with the implementation change.
- Verified result on 2026-07-22: one Rigorium window, six application processes, no external browser process, zero horizontal overflow at desktop and 390-pixel widths, six expected cloud broker requests, and the two expected Connector requests.

## Follow-up boundary

- Do not broaden this increment into attachment transfer, OAuth account management, automatic sync reconciliation, or a bundled third-party MCP/XPI.
- Revisit attachment uploads only with explicit user-visible consent, transfer recovery rules, and a separate Windows packaging and storage review.
