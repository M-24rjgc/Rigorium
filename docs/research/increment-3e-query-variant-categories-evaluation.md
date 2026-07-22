# Increment 3e: query-variant semantic categories and audit presentation

Date: 2026-07-22

## Decision and deliberately narrow delivery

This increment makes an already executed alternative literature query easier to
interpret and audit. It adds an optional semantic category to each concrete
`queryVariants` entry and renders that category next to the corresponding
query-source audit record in the right research panel.

The delivery is intentionally limited to recording the agent's stated reason
for a query formulation. It does **not** automatically generate terms,
discover synonyms, resolve abbreviations, infer historical terminology, query
an ontology, add a search provider, or run a follow-up search without the
agent deciding to do so.

The allowed categories are:

- `primary` for the main query, assigned by the tool rather than accepted from
  an alternative-query input;
- `synonym`;
- `abbreviation`;
- `historical_term`;
- `adjacent_field`.

An alternative may omit its category. Supplying `primary` for an alternative
is rejected, and unknown category values are rejected. The existing cap of
three alternatives, bounded total result budget, source-by-source execution,
identity-aware merging, and partial-coverage behavior remain unchanged.

## Why a category is useful, but is not evidence

The category explains why the agent selected a concrete text formulation. It
is not a claim that an external authority verified that formulation. For
example, a value marked `synonym` remains an agent-selected query label unless
a later terminology-evidence increment attaches a provider record, field,
source URL, and retrieval time to it. The same caution is especially important
for ambiguous abbreviations and time-dependent historical names.

This distinction preserves an honest audit trail:

1. `queryVariants` records the exact query text, allocated request limit,
   optional category, and optional rationale.
2. `queryAudit` records each actual query-variant and source execution,
   including source status, retrieval time, returned count, error state, and
   real query URL.
3. Paper provenance records the query-variant ID that returned each source
   record.

No category silently expands a query or causes a Zotero, export, snapshot, or
other state-changing action.

## Implementation boundary

The boundary stays inside the existing literature-search path:

- `src/research/types.ts` adds the backend `SearchQueryVariantCategory` union
  and optional `SearchQueryVariant.category`.
- `src/tool/builtin/literatureSearch.ts` accepts only the four alternative
  categories, assigns `primary` to the main formulation, validates inputs, and
  preserves the field in the search plan.
- `ui/src/research/types.ts` validates the same closed union before rendering
  an artifact received by the UI.
- `ui/src/research/ResearchPanel.tsx` displays a localized category badge in
  the existing query-audit summary.

It does not modify `LiteratureSource`, OpenAlex/arXiv/Crossref adapters,
candidate-pool ranking, citation expansion, Research Settings, AgentLoop,
Always-On, Electron packaging, or Zotero write confirmation.

## Candidate survey retained for subsequent increments

The following probes were performed as source-selection evidence. They do not
mean that these systems are integrated by this category-only increment.

| Candidate | Observed capability | License or operational boundary | Decision for this increment |
| --- | --- | --- | --- |
| OpenAlex Topics, Keywords, and Work metadata | Public read-only probes returned `200`. Topic records included a description, keyword list, and field hierarchy; work records exposed `topics`, `keywords`, `primary_topic`, and `related_works`. | OpenAlex states that its complete dataset is CC0. The API is JSON over HTTPS and needs no native dependency, but remains a remote, rate- and budget-governed service. | Do not add automatic terminology generation here. Evaluate as a separate evidence-backed terminology increment. |
| PubMed ESearch automatic term mapping | Public `esearch.fcgi` probes returned `translationset` and `querytranslation`; a biomedical phrase was expanded to a MeSH term and lexical alternatives. | Anonymous E-utilities use is rate limited; NLM data terms require attribution and currency disclosure when data are republished or redistributed. | Defer to an explicit biomedical profile, not a cross-disciplinary default. |
| MeSH RDF lookup | Public descriptor lookup and JSON-LD record probes returned descriptor IDs, labels, hierarchy data, and a `historyNote` with an older indexing term. | HTTPS/JSON-LD with no local binary, but terminology coverage is biomedical and NLM terms apply. | Defer with the PubMed profile. |
| Wikidata entity search | Public entity search returned labels, aliases, and descriptions, but the trial phrase produced broad and non-paper entities. | Structured Wikidata data is CC0; interfaces may change. | Do not use for automatic expansion. It may later support explicit entity disambiguation. |
| Semantic Scholar public Graph API | A no-key search probe returned `429`. | API terms, quota, retry, and secure user-owned-key handling require a separate decision. | Defer. |
| `litsearchr` | Provides R-based keyword co-occurrence workflows for systematic reviews. | GPL-3, R runtime and multiple R dependencies; latest repository commit observed in 2021. | Do not embed or launch as a desktop dependency. |
| SciSpaCy | Scientific and biomedical NLP pipeline. | Apache-2.0, but requires a Python environment, spaCy/scientific dependencies, and models. | Do not add a Python service to this Electron increment. |
| LangChain MultiQueryRetriever | Generates multiple queries around a generic retriever. | MIT, but assumes an LLM plus vector retriever and does not preserve Rigorium's source, identity, quota, and audit contracts. | Do not integrate. |

## Future route, kept independent from this delivery

### Follow-up A: OpenAlex evidence terminology

Evaluate a small, typed terminology-evidence adapter using OpenAlex topic and
keyword fields already associated with real returned works. A candidate must
retain its provider record ID, provider field, source URL, retrieval time, and
supporting paper IDs. Topic and adjacent-field labels must not be displayed as
verified synonyms. Prefer reusing keyword fields returned by normal work
searches before adding any extra endpoint request.

### Follow-up B: biomedical terminology profile

Add an opt-in PubMed/MeSH profile only after its settings, request limiter,
attribution/export behavior, and Windows packaged-app test are designed. It
may expose source-backed automatic term mappings and MeSH history notes within
its domain, while keeping them separate from general-purpose terminology.

### Follow-up C: cross-artifact selection provenance

When terminology candidates are persisted, allow a later query variant to
reference a stable earlier candidate ID. Until then, a category and rationale
remain a transparent statement of the agent's selection, not a proof of a
database relationship.

## Verification record

The following checks were executed against the final category-only change and
the newly built Windows package.

| Check | Expected result | Result |
| --- | --- | --- |
| Backend input validation | Main query receives `primary`; alternatives accept only the four non-primary categories; invalid values fail clearly. | Passed in the combined backend run: 18/18 tests. |
| Query budget and audit | Category metadata survives allocation without changing total limits, source execution, provenance, or partial-failure behavior. | Passed in the literature-search and candidate-pool tests. |
| UI artifact guard | A recognized category renders; an unsupported or query-ID-inconsistent category is rejected, while legacy artifacts without a category remain valid. | Passed in the research-panel run: 13/13 tests. |
| Right-panel audit | Each visible query-source run can show its category, rationale, source status, and safe HTTP(S) query link without layout overflow. | Packaged verification found all six query-source audit records, three `primary` badges, three `adjacent_field` badges, zero desktop overflow, and zero 390 px overflow. |
| Regression and package | Targeted tests, TypeScript/lint checks, packaged Electron research verification, and NSIS smoke check remain green. | Root TypeScript, target ESLint, locale parsing, and `git diff --check` passed. Electron verification reported one Rigorium window, zero external browser processes, and successful `app.asar` loading. NSIS produced `release/Rigorium-Setup-0.1.0.exe`. |

The build used Node.js 23.10.0 while the repository declares Node.js 22.x.
The existing engine warning, CSS minifier warnings, and large-chunk warning did
not fail the build, but remain environment or bundle-quality follow-up items
rather than evidence of this increment's behavior.

## References

- [OpenAlex FAQ and license](https://docs.openalex.org/additional-help/faq)
- [OpenAlex Topics API](https://developers.openalex.org/api-entities/topics)
- [NCBI E-utilities usage guidance](https://www.ncbi.nlm.nih.gov/books/NBK25497/)
- [NLM terms and conditions](https://www.nlm.nih.gov/databases/download/terms_and_conditions.html)
- [Wikidata data access](https://www.wikidata.org/wiki/Wikidata:Data_access)
- [Semantic Scholar Academic Graph API](https://api.semanticscholar.org/api-docs/graph)
- [litsearchr repository](https://github.com/elizagrames/litsearchr)
- [SciSpaCy repository](https://github.com/allenai/scispacy)
- [LangChain JS repository](https://github.com/langchain-ai/langchainjs)
