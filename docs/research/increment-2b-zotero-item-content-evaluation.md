# Research literature increment 2B: Zotero item content evaluation

Date verified: 2026-07-22

This record covers item details, child attachments, notes, indexed full text, and citation export. Authenticated cloud writes, version conflicts, and synchronization remain a separate increment because they have different credentials and failure semantics.

## Selected integration boundary

- Zotero Desktop remains the source of truth for bibliographic records, notes, attachments, indexed text, and citation rendering.
- Rigorium reads through the official key-free Local API at `127.0.0.1`; it does not read Zotero SQLite or attachment files directly.
- Opening an item reads metadata and child summaries only. Indexed attachment text requires a separate user click.
- Item detail responses remove local paths and Local API file/view references. Public bibliographic URLs remain available.
- Indexed text is capped at 1,000,000 characters in the provider response and reports whether truncation occurred.
- BibTeX and CSL-JSON use Zotero's official exporters. Citation and bibliography rendering use Zotero's configured CSL processor and the selected Research Settings style.

## Implementations inspected

### Zotero Web API v3 and Local API - selected runtime dependency

- Verified the official item, child-item, full-text, export, `include`, and CSL style contracts documented under the Web API v3 Local API and read-request references.
- The Local API supplies the required deterministic read path without credentials or another bundled runtime.
- The implementation uses `/api/users/0/items/:key/children`, `/api/users/0/items/:attachmentKey/fulltext`, `format=bibtex|csljson`, and `include=data,citation,bib`.
- References:
  - <https://www.zotero.org/support/dev/web_api/v3/basics#local_api>
  - <https://www.zotero.org/support/dev/web_api/v3/read_requests>

### OpenAI curated Zotero plugin revision `11c74d6b` - behavioral reference

- Rechecked the installed plugin's separation of status, item metadata, attachment text, and export operations.
- Adopted the behavior that full text is an explicit operation and that an unavailable desktop returns a diagnostic result without invalidating unrelated research output.
- The plugin's Python helper is not copied or bundled; Rigorium keeps its existing TypeScript provider and Electron runtime.

### `@oscardvs/zoteus` 1.0.4 - deferred to cloud writes

- The package remains a useful TypeScript reference for version-aware Zotero updates and 412 conflict recovery.
- Embedding its MCP server for local item reads would duplicate Rigorium's provider, API, and MCP orchestration.
- No Zoteus code is copied in this increment. Its read-current-version, conditional PATCH, and one-retry conflict pattern will be evaluated again in increment 2C.

### Community Zotero MCP and XPI servers - not embedded

- Python MCP servers add a second runtime and dependency graph for capabilities already supplied by the official Local API.
- Zotero-side XPI servers add installation and Zotero-version compatibility requirements that are unnecessary for this read-only slice.
- They remain optional user-configurable MCP integrations rather than hidden desktop dependencies.

## Implemented contract

- `GET /api/research/zotero/items/:itemKey`
- `GET /api/research/zotero/items/:attachmentKey/fulltext`
- `GET /api/research/zotero/items/:itemKey/export?format=bibtex|csl-json`
- Collection rows expand in place in the right research panel.
- Detail rendering includes normalized metadata, tags, notes, and attachment summaries.
- Attachment text, BibTeX, and CSL-JSON are initiated only by explicit UI actions.
- Disabled or unreachable Zotero states preserve the HTTP 200 plus `available: false` contract; invalid keys and missing items remain diagnosable request errors.

## Verification boundary

- Provider tests cover path removal, child normalization, explicit full-text access, the response cap, official export formats, and CSL rendering.
- UI tests cover lazy item details, lazy attachment text, empty indexed text, and both citation export formats.
- The packaged Electron verification injects Zotero-shaped responses and exercises details, full text, and export from the built application at desktop and 390 px widths.
- No authenticated cloud write is claimed by this increment.

## Next decision

Increment 2C will separately evaluate cloud credentials, secure storage, library selection, write tokens, `If-Unmodified-Since-Version`, `Last-Modified-Version`, dry runs, explicit confirmation, conflict presentation, and synchronization status. Local search and item reading must continue to work when cloud credentials are absent.
