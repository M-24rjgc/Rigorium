# Increment 3c: citation-expansion evaluation

Date: 2026-07-22

## Decision for this slice

Add a small, local OpenAlex adapter extension for a verified paper's
`references` and `citations`. It runs through the existing Node/Electron
network layer and emits the existing normalized paper and citation-edge shape.
It does not introduce a local service, an MCP subprocess, a Zotero write, or a
fixed research workflow.

This is deliberately a provider decision for the current slice, not a decision
to exclude future source comparison or a later multi-provider expansion.

## Live probes

The following probes were run on 2026-07-22 against public endpoints using a
small, read-only request set.

| Candidate | Probe result | Consequence for this slice |
| --- | --- | --- |
| OpenAlex Works API | `W2626778328` returned 28 `referenced_works`; a batched `openalex_id:` OR lookup hydrated 22 and exposed six missing records. `filter=cites:W2626778328` reported 6,600 citing works and cursor paging returned disjoint first and second pages. | It supplies both directed relations, pagination, canonical OpenAlex IDs, DOI metadata, and source-local counts without another runtime. Missing hydration is represented as partial coverage rather than fabricated nodes. |
| Semantic Scholar Academic Graph API | Public probes for `/references`, `/citations`, and `/paper/batch` returned structured results. A direct paper lookup was rate limited during the same evaluation, and the recommendations endpoint returned an empty list for the tested seed. | Valuable later comparison candidate, but not a dependency for this first reliable path. It needs separate key, rate, terms, caching, and provenance decisions. |
| Crossref REST API | A work probe supplied publisher reference records and `is-referenced-by-count`, but not individual citing-work records. | Retain as metadata source; do not treat it as a citation-neighborhood provider. |
| Citation.js | Current package metadata identifies `@citation-js/core` 0.8.2 as MIT and describes format conversion/CSL processing. | Useful for citation formatting if a later need is not already covered by Zotero; it does not retrieve a citation graph. |

The OpenAlex related-work endpoint was also observed, but it is intentionally
outside this slice. An opaque related-work ranking must be separately labelled
and evaluated; it must not be rendered as a citation or shared-topic edge.

## OpenAlex operating constraints

- Reference IDs are fetched through `filter=openalex_id:W...|W...`.
  OpenAlex documents a maximum of 100 OR values. This slice caps one reference
  hydration request at 100 and records a warning and `truncated` state instead
  of silently chunking beyond the user-visible budget.
- Citing works are queried through `filter=cites:<seed-work-id>`. Their edges
  point from the citing paper to the seed paper; outgoing references point from
  the seed paper to the referenced paper.
- The public documentation checked on 2026-07-22 states a 100 request/second
  ceiling and a daily monetary usage budget: anonymous requests receive
  USD 0.10/day, while a free user-owned API key receives USD 1/day. No-key use
  is appropriate only for small trial workloads; higher-volume use needs an
  optional user-owned API key and an explicit secure-storage policy. The
  adapter does not automatically retry HTTP 429, so a provider quota signal is
  exposed as direction-level partial coverage instead of being converted into
  zero results or an early repeat request.
- OpenAlex's published data/API license is CC0. Individual linked full text is
  not fetched or relicensed by this metadata operation.

## Why not an MCP wrapper or a graph service now

The existing application already has a typed tool runtime, a network boundary,
Research Settings, normalized identities, provenance, and an Electron packaging
path. An MCP wrapper would add another process and credential boundary while
still needing this artifact, coverage, and UI logic. A graph server would add
deployment and persistence before the first directed edge path has been
validated. Neither increases correctness for the current two-direction request.

## Non-decisions retained for later evaluation

- Whether Semantic Scholar, OpenCitations, or another source should add a
  second independent citation index.
- Whether related works, co-citation, bibliographic coupling, or semantic
  similarity should enter the map and how their evidence should be labelled.
- API-key storage, higher-volume quotas, caching, and long-running incremental
  refresh policy.
- Any change to AgentLoop, Always-On, Zotero write confirmation, or the wider
  literature-search source ranking.

## Primary references

- [OpenAlex Works filters](https://developers.openalex.org/api-entities/works/filter-works)
- [OpenAlex filtering and OR limits](https://developers.openalex.org/guides/filtering)
- [OpenAlex authentication, limits, and pagination guidance](https://developers.openalex.org/api-reference/authentication)
- [OpenAlex Works endpoint](https://developers.openalex.org/api-reference/works/list-works)
- [Semantic Scholar Academic Graph API](https://api.semanticscholar.org/api-docs/graph)
- [Semantic Scholar Recommendations API](https://api.semanticscholar.org/api-docs/recommendations)
- [Crossref REST API documentation](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)
- [Citation.js](https://github.com/citation-js/citation-js)
