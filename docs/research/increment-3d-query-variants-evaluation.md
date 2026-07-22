# Increment 3d: query variants and multi-query candidate pool

Date: 2026-07-22

## Decision for this slice

Extend the existing `literature_search` tool so the agent can submit a primary
academic query plus at most three alternative formulations. The tool allocates
the configured total result budget across the formulations, runs the existing
enabled sources, records every query-source attempt, and merges results through
the existing identity-aware candidate pool.

This keeps query interpretation with the agent and request reliability with the
provider adapters. It adds no slash command, vector database, background
service, native dependency, or fixed research workflow.

## Candidates actually probed

| Candidate | Probe result | Decision |
| --- | --- | --- |
| Existing Rigorium source adapters and candidate pool | OpenAlex, arXiv, and Crossref already expose normalized identities, query URLs, source status, retry behavior, and deterministic candidate merging. | Reuse directly and add a thin multi-query orchestration layer. |
| OpenAlex Topics and Autocomplete APIs | Both public endpoints returned structured topic candidates. OpenAlex publishes its data and API metadata as CC0. | Retain as a later optional topic-suggestion adapter; do not make it a hidden automatic dependency in this slice. |
| LangChain `MultiQueryRetriever` | The maintained package is MIT-licensed, but its implementation assumes an LLM plus vector retriever and deduplicates generic documents rather than scholarly identities and provenance. | Do not integrate. Its runtime and data contract do not preserve source status, DOI/arXiv identity, query URLs, or provider limits. |
| Wikidata entity search | The public endpoint responded and Wikidata data is CC0, but the tested research phrases returned broad non-paper entities and ambiguous terms. | Do not use for automatic literature query expansion. It may be reconsidered for explicit entity resolution. |
| Semantic Scholar public API | The evaluation request returned HTTP 429. | Do not add it to the default path without separate key, quota, terms, and failure-state work. |

## Implemented contract

- The primary query remains `SearchPlan.query` for backward compatibility.
- Executed formulations are stored as `SearchPlan.queryVariants`, each with an
  artifact-local ID, request limit, and optional rationale.
- Every source attempt is stored in `queryAudit`; paper provenance records the
  query-variant ID that produced the record.
- Candidate fusion treats `(source, query variant)` as one ranked channel while
  DOI, arXiv, OpenAlex, PMID, and other strong identities still control merging.
- One failed formulation keeps successful siblings and changes coverage to
  `partial` instead of discarding the artifact.
- The sum of per-variant request limits never exceeds the final result budget.

## Live verification

A read-only OpenAlex run used the primary query `large language model agents`
and the alternative `LLM autonomous agents`, with a total limit of four.

- Each query received a request limit of two and returned status `ok`.
- Four provider records merged into three unique papers.
- `A survey on large language model based autonomous agents` retained both
  `primary` and `alternative-1` provenance.
- Coverage was `complete`, with the two real OpenAlex query URLs retained in the
  query audit.

## Deliberate non-decisions

- Automatic generation of synonyms, historical terms, acronyms, or adjacent
  fields remains an agent decision. A provider topic-suggestion adapter can be
  evaluated independently when that feature is developed.
- Detailed query-audit presentation in the right research panel is not part of
  this backend candidate-pool slice.
- OpenReview, Semantic Scholar, Wikidata, embeddings, and vector retrieval are
  not introduced by this change.

## Primary references

- [OpenAlex API overview](https://developers.openalex.org/)
- [OpenAlex Topics](https://developers.openalex.org/api-entities/topics)
- [OpenAlex data license](https://docs.openalex.org/additional-help/faq#how-is-openalex-licensed)
- [LangChain JS repository](https://github.com/langchain-ai/langchainjs)
- [Wikidata data access and licensing](https://www.wikidata.org/wiki/Wikidata:Data_access)
- [Semantic Scholar Academic Graph API](https://api.semanticscholar.org/api-docs/graph)
