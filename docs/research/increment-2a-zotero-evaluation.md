# Research literature increment 2A: Zotero read-path evaluation

Date verified: 2026-07-22

This record covers the project-to-Collection binding and read-only library path implemented in increment 2A. It does not select the later full-text, synchronization, or write-conflict implementation in advance.

## Selected integration boundary

- Zotero remains the authoritative library for formal references, Collections, tags, notes, and attachments.
- Rigorium stores only the configured Collection key and display name in Research Settings.
- Local reads use Zotero Web API v3 under `http://127.0.0.1:23119/api/users/0/...` with `Zotero-API-Version: 3`.
- Confirmed imports continue to use the Connector server with `X-Zotero-Connector-API-Version: 3`.
- Zotero SQLite is never read or written directly.
- Library unavailability is represented as data on the Zotero endpoints; it does not fail an already-completed external literature search.

## Implementations inspected and run

### OpenAI curated Zotero plugin - behavioral reference

- Inspected the local API route reference and the stdlib-only helper at upstream package revision `11c74d6b`.
- Ran its `status --json` command against the installed Zotero profile.
- The probe identified Zotero 9.0.5 as installed, the local API preference as enabled, and both the Local API and Connector as unavailable while Zotero was closed.
- Reused behavior: route split, version headers, top-level item reads, status diagnostics, and explicit write confirmation.
- Reuse model: behavioral reference only; its Python implementation is not copied into Rigorium.

### Zotero official local API - selected runtime dependency

- The official desktop API exposes Web API v3-compatible, key-free local reads under `/api/users/0`.
- Collection reads, top-level item reads, item lookup, query modes, pagination, and `Total-Results` map directly to the required Rigorium contracts.
- The local API is read-only. Connector or authenticated Web API operations are therefore kept behind a separate write boundary.
- A hidden launch attempt exited before opening port 23119 on the verification machine, so this increment preserves and tests the real closed-desktop state in addition to mocked API-ready responses.

### `54yyyu/zotero-mcp` 0.6.2 - retained as an optional MCP

- Repository and package were active and MIT-licensed when checked.
- `uvx --from zotero-mcp-server zotero-mcp --help` ran successfully.
- The base command resolved and installed 102 Python packages on the verification machine.
- It offers broad search, annotations, writes, semantic indexing, and optional PDF features, but embedding that Python environment would materially enlarge and complicate the Electron runtime.
- Adoption decision: do not embed it for the deterministic read path. It remains a candidate user-configurable MCP for later semantic and annotation capabilities.

### `@oscardvs/zoteus` 1.0.4 - retained as an optional TypeScript MCP

- npm metadata reported MIT, Node 20.19+, and an unpacked package size of about 580 KB plus dependencies.
- `pnpm dlx @oscardvs/zoteus --help` started its stdio MCP and correctly reported that neither cloud credentials nor a running local API were available.
- Its TypeScript stack and safe-write design fit Rigorium better than a bundled Python service, but embedding a second MCP process would duplicate the app's existing MCP and REST orchestration for this small read-only increment.
- Adoption decision: revisit its safe writes, CSL, full-text, and scholarly-context modules during the corresponding increments; do not vendor or copy them here.

### `cookjohn/zotero-mcp` - not selected for the base path

- The project was active and MIT-licensed when checked.
- Its current architecture requires installing a Zotero XPI that hosts a Streamable HTTP MCP server on a separate port.
- That deeper Zotero-side extension can expose capabilities unavailable through the read-only local API, but it adds an installation and compatibility requirement that is unnecessary for Collection binding and item browsing.
- Adoption decision: retain as a later write/full-text candidate only after testing its released XPI with the then-current Zotero version.

## Implemented contract

- `GET /api/research/zotero/collections`
- `GET /api/research/zotero/items`
- `POST /api/research/zotero/match`
- Project/global settings fields `zotero.collectionKey` and `zotero.collectionName`
- Exact matching by Zotero key, DOI, arXiv ID, or PMID, with a guarded title-and-year fallback
- Explicit `available: false` responses for disabled, closed, or unreachable Zotero states

## Upgrade policy

- Full text, attachments, notes, BibTeX/CSL export, cloud writes, synchronization versions, and conflicts remain increment 2B work.
- Any third-party MCP or XPI adopted later must be run again, pinned to an upstream version, and checked for license, Windows packaging, data ownership, and failure isolation.
- The stable `LibraryProvider` contract remains independent of the Agent loop and of any specific MCP transport.
