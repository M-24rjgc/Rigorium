# Research literature increment 1: source and integration record

Date verified: 2026-07-22

This record documents the implementation choices for the first usable research-literature slice. It is intentionally limited to the capabilities that are present in this increment.

## Academic metadata candidates

### OpenAlex — selected as the first default source

- Live request succeeded without an account or API key.
- The tested response included stable work identifiers, DOI, authors, publication year, venue, citation count, topics, open-access status, and `referenced_works`.
- A three-result smoke request returned 123 references for the first result, which was enough to construct real citation edges among returned papers.
- Its response shape is suitable for both a ranked source list and the first relationship-map data contract.
- Integration model: direct API adapter behind the `LiteratureSource` interface. No OpenAlex source code is copied into Rigorium.

### Semantic Scholar Academic Graph API — retained as a later optional source

- A live unauthenticated request returned HTTP 429 on the verification machine.
- The API has useful paper and citation fields, but the unauthenticated rate-limit behavior makes it unsuitable as the only zero-setup source for the first desktop path.
- A later increment can add it as a configured source with its own key, budget, rate-limit, and coverage status.

### Crossref REST API — retained as an identity and metadata supplement

- A live request succeeded and returned DOI-oriented publication metadata.
- The first tested result did not provide reference entries, so the response was less map-ready than OpenAlex for this slice.
- Crossref remains a strong future supplement for DOI reconciliation and publisher metadata, not the first relationship source.

## Zotero integration reference

- Zotero Desktop local API base: `http://127.0.0.1:23119`.
- `/api/users/0/...` is used only for local reads.
- `/connector/getSelectedCollection` identifies the current write target.
- `/connector/import?session=...` performs the explicitly confirmed BibTeX import.
- The OpenAI curated Zotero plugin at upstream commit `11c74d6ba24d3a6d48f54a194cd00ef3beea18f9` (MIT) was inspected as a behavioral reference for local routes and confirmation rules.
- Rigorium uses its own TypeScript provider and does not copy the plugin's implementation code.
- Direct writes to Zotero SQLite are not used.

## UI and plugin decisions

- The current graph is a small native SVG renderer used to verify the end-to-end artifact and interaction contract.
- It is not a commitment for the later full literature-map increment; graph engines and bibliometric projects will be evaluated again before that increment.
- `rigorium-literature` and `rigorium-zotero` use Rigorium's native built-in `plugin.json` protocol. Codex marketplace manifests are not introduced into the application runtime.
- The stable boundaries are the `LiteratureSource`, `LibraryProvider`, `ResearchSettings`, paper identity, and research artifact contracts under `src/research/`.
- UI-capable plugins can publish a validated artifact through the read-only `rigorium:research-artifact` browser event; the built-in chat tool uses the same panel context directly.

## Upgrade policy

- API adapters remain isolated from the Agent loop and UI renderer.
- New sources must preserve per-source query URL, retrieval time, result count, coverage description, and failure state.
- Zotero writes must continue to require an explicit confirmation at the operation boundary.
- Source behavior and terms should be rechecked before enabling a new source by default.
