# Research literature increment 3: multi-source discovery evaluation

Date verified: 2026-07-22

This record evaluates the next source boundary after the first usable OpenAlex search path. It does not claim that all candidates are integrated, and it does not select a permanent graph engine or a fixed research workflow. The implementation decision for the first increment-3 slice is deliberately narrow: add Crossref as the second enabled metadata source while retaining OpenAlex as the initial relationship source.

## Existing boundary and decision rule

- The existing `literature_search` tool is read-only, permission-gated for network access, and respects `privacy.allowRemoteMetadataSearch` plus the configured search budget.
- `LiteratureSource`, `SearchPlan`, `PaperIdentity`, `ResearchPaper`, `ResearchSourceStatus`, and `ResearchArtifact` are the extension boundary under `src/research/`. `SearchPlan.sourceIds` already permits multiple source IDs, but settings and the current tool currently instantiate only OpenAlex.
- A source adapter must return its own query URL, retrieval time, result count, coverage description, and a structured error. A failure of one source must not discard successful results from another source.
- Cross-source results must be reconciled before presentation. DOI is the first strong shared identity; arXiv ID, OpenReview ID, PMID, and PMCID are other strong identities. Title/year/first-author comparison is only a guarded fallback, never an automatic destructive merge.
- A merged paper must keep every contributing source ID and source-specific fields. In particular, Crossref metadata must not erase the existing OpenAlex ID or its real citation edges.

## Live probe method

The following probes used a generic academic query, three or fewer records, public read-only endpoints, no account, no API key, no cookies, and the same descriptive user agent. They are availability observations on this Windows verification machine, not a promise of future provider uptime or a global benchmark.

| Source | Minimal endpoint result | Returned form and useful fields | Operational observation |
| --- | --- | --- | --- |
| Crossref | HTTP `200`, JSON, about `2.1s` in the three-result probe. A second local reduced-`select` probe returned `200` in about `2.9s`. | DOI, title, author, date, container title, type, URL, and `is-referenced-by-count`. | The second probe returned `X-Rate-Limit-Limit: 3`, `X-Rate-Limit-Interval: 1s`, and no `Retry-After`. |
| arXiv | HTTP `200`, Atom XML, about `2.4s`. | Stable arXiv entry ID, title, summary, authors, published/updated dates, categories, optional DOI and journal reference. | The official manual asks callers making repeated requests to leave a three-second delay. |
| Semantic Scholar | HTTP `429` in about `0.35s`. | The requested Graph API shape supports paper IDs, external IDs, abstract, authors, venue, citation count, references, and open-access PDF metadata. | The body explicitly requested waiting or applying for an API key. |
| OpenReview | HTTP `403` in about `0.4s`. | API v2 records can describe submission/venue/review entities. | The response was `ChallengeRequiredError` with a challenge URL, despite unused rate-limit capacity in the response headers. |
| Europe PMC | HTTP `200`, JSON, about `1.0s`. | PMID, PMCID, DOI, title, authors, abstract, publication data, journal, citation count, and open-access flags for biomedical records. | Broadly usable for its domain, but not a general scholarly corpus. |
| OpenCitations | HTTP `200` for `meta/v1/metadata/doi:...`, about `2.0s`; Index v2 DOI-reference lookup also returned `200` for the probe identifier. | DOI-oriented metadata and citation/reference enrichment once an identifier is already known. | The tested Index reference list was empty; this is not full-text or broad keyword discovery. |

The observed Crossref headers are a runtime signal, not a hard-coded service contract. The adapter must read `Retry-After`, `Backoff`, and provider rate-limit headers when present, serialize or budget requests accordingly, and surface a partial-coverage result instead of retrying aggressively.

## Candidate-by-candidate assessment

### Crossref REST API — adopt now as the second default metadata source

- Official protocol reference: <https://www.crossref.org/documentation/retrieve-metadata/rest-api/>. The verified guide documents JSON metadata retrieval and the `mailto` form of the polite pool.
- Authentication and rate behavior: public read access requires no user key. The integration must send a descriptive User-Agent, use an optional Research Settings contact address, honor returned rate/backoff headers, bound pagination, and use the existing request timeout and retry policy. It must not assume that the observed `3 / 1s` value is stable across networks or time.
- Field fit: Crossref provides the strongest addition to the current OpenAlex path for canonical DOI reconciliation, publisher/depositor metadata, publication/container/type details, and source coverage. Its `is-referenced-by-count` is useful evidence but is not a replacement for a complete citation graph. Deposited reference lists are not sufficiently complete to make Crossref the first map-edge provider.
- Rights and reuse: Rigorium calls the documented HTTP service; it does not copy, bundle, or modify Crossref source code. Crossref's web-site content license must not be mistaken for a blanket license over every deposited metadata field. Store provenance and source URLs, do not copy remote full text, and preserve any supplied rights/license information where present.
- Windows/Electron risk: low. The adapter is JSON over the existing Node-side network path, needs no native module, no child process, and no renderer credential. It remains behind the existing network permission and remote-metadata privacy switch.
- Decision: **adopt in increment 3A**. It becomes the second enabled source beside OpenAlex. Its contribution is a metadata/identity supplement; the initial map continues to use verified OpenAlex relationship evidence.

### arXiv API — approve for the next staged source, not this slice

- Official references: <https://info.arxiv.org/help/api/user-manual.html>, <https://info.arxiv.org/help/api/tou.html>, and <https://info.arxiv.org/help/license/reuse.html>.
- Authentication and rate behavior: public read access needs no key. The verified manual explicitly asks clients to include a three-second delay between repeated calls and documents paging limits. Any adapter needs a per-source queue rather than generic parallel retries.
- Field fit: arXiv gives the preprint identity, abstract, authorship, submitted/updated dates, categories, DOI, and journal reference that a general metadata source often lacks or lags. It does not provide a dependable citation/reference graph in the Atom response, so it should enrich discovery and identities rather than manufacture map edges.
- Rights and reuse: arXiv's API terms and permissions/reuse guidance apply. Article and version rights are record-specific; this increment is metadata-only and must retain any returned license link rather than treating a search response as permission to download or redistribute paper content.
- Windows/Electron risk: low binary risk but a real parsing/operational concern. The response is namespaced Atom XML, so the later adapter must use a maintained pure-JavaScript XML parser, cap input size, reject malformed entities, and preserve the three-second source queue. No browser automation or native runtime should be introduced.
- Decision: **approved for a subsequent increment-3 slice**, after Crossref's merge and partial-failure contract is in place. It should be a default preprint source only if the queue and XML parser pass Windows packaged-app tests.

### Europe PMC REST service — approve as an opt-in biomedical profile, not a global default

- Official REST entry point: <https://europepmc.org/RestfulWebService>.
- Authentication and rate behavior: the live public JSON search worked without a key. The adapter must still use source-local pagination, timeout, cancellation, and error reporting; absence of an advertised key requirement is not authorization for unbounded fan-out.
- Field fit: the core search response is particularly suitable for biomedical/life-science projects because it can reconcile PMID, PMCID, DOI, abstracts, journals, dates, cited-by counts, and open-access state. Its domain scope makes it a poor default supplement for computer science, social science, and general venue discovery.
- Rights and reuse: Rigorium would call the public REST interface and bundle no Europe PMC code. Search metadata and open-access flags do not authorize fetching or redistributing every linked full text. Preserve source IDs and source-provided rights/open-access fields; keep full-text retrieval behind the existing explicit remote-full-text setting.
- Windows/Electron risk: low. This is a JSON-only Node-side adapter with no credential, plugin process, or native dependency. The main risk is incorrect product scope, not packaging.
- Decision: **approved only as a later opt-in biomedical source profile**. Do not enable it for every project by default.

### OpenCitations — approve later for DOI-driven citation enrichment, not discovery

- Official Index API reference: <https://opencitations.net/index/api/v2>. The verified page identifies the current Index API URL and its documented endpoint surface. OpenCitations states that its dataset data is released under the CC0 Public Domain Waiver: <https://opencitations.net/>.
- Authentication and rate behavior: the read-only metadata and Index requests succeeded without a key. A later adapter must still obey response-level errors/backoff, cache DOI lookups, and avoid N-by-N graph expansion.
- Field fit: it is useful after DOI normalization for citation/reference enrichment and provenance. It is not a broad keyword/ranking service, and a `200` response can validly contain an empty citation or reference list. It must never turn an empty list into a claim that a paper has no citations globally.
- Rights and reuse: only the public HTTP data contract is used; no OpenCitations/RAMOSE implementation is copied. The API documentation itself notes separate document/API implementation licenses, which are irrelevant unless source code is later vendored.
- Windows/Electron risk: low transport risk, but potentially high request-amplification risk when building a map. Keep it out of the default search fan-out and require a bounded DOI-enrichment budget.
- Decision: **approved as a later enrichment adapter** after the canonical identity and map-budget work. It is not a default discovery source.

### Semantic Scholar Academic Graph API — defer from the default path

- Official references: <https://www.semanticscholar.org/product/api>, <https://api.semanticscholar.org/api-docs/graph>, and <https://www.semanticscholar.org/product/api/license>.
- Authentication and rate behavior: the official product page says most endpoints are public but may be throttled under heavy use, recommends API keys, and documents a key-specific introductory rate. The live unauthenticated `429` proves that the shared public route is not sufficiently reliable as a zero-setup default on this machine.
- Field fit: its Graph API has attractive paper IDs, external IDs, citation/reference fields, citation measures, and open-access metadata. It is therefore a strong future optional graph source, not an invalid source.
- Rights and reuse: use is governed by Semantic Scholar's API License Agreement; no SDK or service code should be copied. A future configured key must be held outside renderer-visible settings and logs, using the same secure credential principles as the existing protected cloud integration.
- Windows/Electron risk: low native packaging risk but high operational and secret-management risk. A keyless default would make normal searches vulnerable to the observed shared-limit behavior.
- Decision: **defer**. Re-evaluate only as an explicit user-configured source with secure credential storage, per-source rate budget, `429`/`Retry-After` handling, and a successful live smoke test.

### OpenReview API — defer until an officially supportable desktop access path is verified

- Official references: <https://docs.openreview.net/getting-started/using-the-api> and <https://openreview.net/legal/terms>.
- Authentication and rate behavior: the public API v2 request returned `ChallengeRequiredError` and a challenge URL. The response advertised unused quota, so this is not a simple client-side rate-limit retry case. A headless Electron/Node search adapter cannot solve that challenge by replaying requests or launching hidden browser automation.
- Field fit: OpenReview is valuable for venue-specific submissions, decisions, revisions, review artifacts, and accepted-status context. Its records are not a dependable general discovery corpus when the public HTTP path itself is challenged.
- Rights and reuse: use is subject to OpenReview's terms. No OpenReview code, review content, authenticated browser session, or challenge-solving mechanism is copied or bundled.
- Windows/Electron risk: high. A hidden browser, cookie replay, or anti-bot workaround would undermine predictable desktop packaging and user trust. It must not be made a background dependency.
- Decision: **defer**. Reconsider only after a documented, stable, user-authorized API route works in a packaged Windows smoke test without challenge bypassing.

## Increment 3A implementation boundary

The approved next code slice is intentionally limited to Crossref plus the common multi-source contract it requires:

1. Add a Crossref `LiteratureSource` adapter behind the existing Node-side network layer, with an enabled setting, optional polite-pool contact, bounded page size, cancellation, timeout, and rate/backoff handling.
2. Add a candidate-pool merger that recognizes strong identities and retains all source provenance, query URLs, ranks, and retrieval times. Do not overwrite OpenAlex IDs or relationship evidence.
3. Execute enabled sources independently. If Crossref fails while OpenAlex succeeds, return the OpenAlex results with `coverage.status: "partial"` and a Crossref-specific diagnostic; do the symmetric case as well.
4. Keep Crossref-derived relations out of the initial graph unless the evidence is an explicit, normalized citation relation. The existing OpenAlex graph behavior remains the baseline during this slice.
5. Test the new adapter with fixtures, a failure/`429` path, DOI merge behavior, partial coverage, privacy-disabled behavior, and a live three-record smoke request. Then verify the packaged Electron app before deciding whether to start the arXiv slice.

The implemented Crossref adapter keeps one FIFO gate per endpoint in the Node/Electron process. It derives the minimum request interval from returned rate headers, preserves full `Retry-After`/`Backoff` values, and does not automatically retry provider HTTP statuses; a limited transport retry remains for connection failures. Response-body reading shares the remaining request timeout and caller abort signal, is capped at 1 MB before JSON parsing, cancels stalled streams, and releases the endpoint permit in `finally`.

## Non-decisions and recheck policy

- This record does not bundle third-party MCPs, web scrapers, browser automation, provider SDKs, or external source code.
- It does not expose provider-specific search commands to users. The agent continues to turn natural-language research requests into queries; explicit UI actions remain only for state-changing operations such as Zotero writes, exports, and snapshots.
- Before enabling each later source, rerun its live probe and recheck the linked official documentation, current terms/license, rate behavior, result shape, and Windows packaged-app behavior. A source's successful response in this document is not a permanent compatibility guarantee.
