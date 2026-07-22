# Research literature increment 3B: arXiv API readiness evaluation

Date verified: 2026-07-22

This record evaluates the official legacy arXiv API as the next staged literature source after the existing OpenAlex and Crossref paths. It is a source-selection and integration-boundary decision only: no arXiv adapter, UI setting, parser dependency, scraper, browser automation, or third-party SDK is introduced by this document.

## Decision

- Approve arXiv as a **default-enabled, project-disableable preprint metadata source** for the next increment-3 slice, conditional on the operational safeguards below.
- The default is justified by public, key-free, cross-domain preprint metadata; the current default result budget of 25 fits comfortably inside the existing per-search budget and does not require paging in the first adapter.
- The apparently small request cost must not be mistaken for permission to fan out: arXiv's current Terms of Use apply one request per three seconds and one connection at a time across all machines under the user's control.
- Keep it separate from the existing map-edge source. arXiv contributes preprint identity, abstract, subject classifications, submission/update time, optional DOI, and optional journal reference. It does **not** supply a reliable citation/reference graph in this Atom search response.
- Keep a visible global/project source toggle. Disabling arXiv must not disable OpenAlex or Crossref, and an arXiv failure must produce partial coverage rather than discard successful sibling results.

This is not an approval to retrieve, mirror, or redistribute PDFs. The first adapter is descriptive-metadata only.

## Official basis

Primary sources checked on the verification date:

- [arXiv API User's Manual](https://info.arxiv.org/help/api/user-manual.html)
- [Terms of Use for arXiv APIs](https://info.arxiv.org/help/api/tou.html)
- [Permissions and Reuse FAQ](https://info.arxiv.org/help/license/reuse.html)
- [arXiv licenses](https://info.arxiv.org/help/license/index.html)

### Access, rate limit, and identification

- The documented API query surface is public and needs no account, cookie, or API key for this metadata use case.
- The Terms of Use explicitly say that the legacy APIs, including the arXiv API, allow no more than **one request every three seconds** and a **single connection at a time**. The same limit covers all machines under a user's control; adding renderer processes, Electron windows, test workers, or another machine is not a valid way to increase throughput.
- The User's Manual also asks repeat callers to incorporate a three-second delay. It describes API changes as possible compatibility events, so the adapter must treat the source contract as versioned external input rather than a frozen implementation detail.
- Neither the current User's Manual nor the current API Terms of Use declares a `User-Agent` header or a `mailto` parameter as a hard provider requirement. The probes nevertheless used a descriptive non-personal User-Agent. The implementation should continue to send one for operator diagnostics, but must not claim it is an arXiv authentication or polite-pool requirement, and must not copy Crossref's `mailto` convention into arXiv requests.

### Query, paging, and sort contract

The documented query parameters are `search_query`, `id_list`, `start`, `max_results`, `sortBy`, and `sortOrder`.

- Search prefixes include `ti` (title), `au` (author), `abs` (abstract), `co` (comment), `jr` (journal reference), `cat` (subject category), `rn` (report number), `id`, and `all`. The manual recommends `id_list` instead of `search_query=id:...` so article versions are handled correctly.
- `AND`, `OR`, and `ANDNOT` combine fields. Parentheses and quoted multiword phrases are URL-encoded grouping syntax. URL construction must use a real URL encoder, not string concatenation.
- arXiv exposes a `submittedDate` range filter. Its format is `[YYYYMMDDTTTT TO YYYYMMDDTTTT]` in GMT, to the minute. It means the time a work was submitted to arXiv, not its publisher publication date and not necessarily its latest revision date.
- `sortBy` supports `relevance`, `lastUpdatedDate`, and `submittedDate`; `sortOrder` supports `ascending` and `descending`. It has no cited-by-count sort. A generic request for citation ranking must therefore either leave arXiv at relevance with a source warning or exclude arXiv from that ranking, never pretend that the provider honored a citation-count order.
- Paging uses zero-based `start` and `max_results`, with `opensearch:totalResults`, `opensearch:startIndex`, and `opensearch:itemsPerPage` returned in the feed. The manual says requests should be in slices of at most 2,000 and that `max_results > 30,000` produces HTTP `400`; it recommends refining result sets over 1,000 and using OAI-PMH for bulk harvesting.

The current Rigorium default is 25 results (with a separately configured per-search ceiling). The first adapter should send exactly one first-page request per user search and must not add automatic pagination or background expansion. A later explicit expansion feature must enqueue each page behind the same three-second gate and remain below both the user budget and the official page limits.

### Atom response and identity fields

The response body is Atom 1.0, including documented error bodies. The expected feed-level information includes title, ID, link, updated time, and OpenSearch paging values. A normal entry can carry:

- Atom `id`, `title`, `published`, `updated`, `summary`, authors, categories, and links;
- `arxiv:primary_category`, alongside potentially multiple Atom `category` elements;
- optional arXiv extension data such as `arxiv:comment`, author affiliation, `arxiv:journal_ref`, and `arxiv:doi`.

For Rigorium, normalize the stable arXiv work identifier from the `/abs/...` entry URL into `PaperIdentity.arxiv`; preserve the source record's versioned identifier in provenance or source-specific metadata rather than making a new paper for each `vN`. DOI remains a strong cross-source merge key when supplied. DOI absence, an arXiv URL, a matching title, or an overlapping author list must not destroy another source's identity or source provenance.

The category/date probe below is also a reminder that the primary category is not necessarily the category that matched the query: a work can be cross-listed. Retain all returned categories as source metadata; do not turn them into citation edges or claim that a primary category alone explains a match.

## Rights and data-use boundary

- The API Terms of Use place **descriptive metadata** under CC0 1.0. The terms explicitly include title, abstract, authors, identifiers, and classification terms in that metadata category. Storing and presenting those fields with source provenance is within the selected slice.
- Individual e-prints remain subject to copyright. arXiv is not the copyright holder, and the Terms prohibit storing and serving PDF/source/content from Rigorium unless the copyright holder or that work's license permits it.
- The reuse FAQ states that a work's license is not part of the current search API schema. Therefore an Atom result must not be treated as a reuse license, a permission to redistribute, or a guarantee that a linked PDF can be bundled. Link users to the canonical arXiv abstract page for content access.
- Publicly readable arXiv material is useful discovery evidence, but it is not sufficient to silently classify a work as freely redistributable. Any later remote full-text feature must retain the existing explicit privacy/consent boundary and evaluate the work-level license separately.

## Live probe evidence

The directly run probes used `https://export.arxiv.org/api/query`, one connection, a descriptive User-Agent, `max_results=3` or fewer, no API key, no cookies, and a minimum 3.2-second gap between requests issued by this evaluation. The ordinary-keyword observation was supplied by the main incremental probe as a separate one-off signal. Latency is an observation from this Windows verification machine, not an SLA. The shared keyword probe and the probes below returned Atom XML with no `DOCTYPE` or `ENTITY` declaration in the observed body; that is not a reason to trust future provider XML without defensive parsing.

| Probe | Query / purpose | Result | Response observation |
| --- | --- | --- | --- |
| Ordinary keyword | Main incremental probe, `max_results=3` | `200`, 3 entries | About `735 ms`; `application/atom+xml; charset=utf-8`; `Content-Length` and received size `8,062` bytes; no `Retry-After` or `Cache-Control` header. |
| Phrase-scoped title | `search_query=ti:"Attention Is All You Need"`, relevance sort, `max_results=3` | `200`, 3 entries of 35 total | About `875 ms`; `7,091` bytes actual and declared; first entry was `Attention Is All You Need`, `http://arxiv.org/abs/1706.03762v7`, published `2017-06-12T17:57:34Z`, primary category `cs.CL`; no `Retry-After` or `Cache-Control`. |
| Category plus submitted-year range | `search_query=cat:cs.LG AND submittedDate:[202501010000 TO 202512312359]`, submitted-date descending, `max_results=3` | `200`, 3 entries of 46,009 total | About `923 ms`; `8,084` bytes actual and declared; first result was submitted `2025-12-31T23:55:56Z` but had primary category `eess.IV`, demonstrating that a `cat:cs.LG` match can be a cross-list rather than the primary category; no `Retry-After` or `Cache-Control`. |
| Manual's malformed-ID example | `id_list=1234.12345`, `max_results=1` | `200`, a valid empty Atom feed, 0 entries / 0 total | About `623 ms`; `691` bytes actual and declared; no Atom error entry, no `Retry-After`, and no `Cache-Control`. |

The manual documents an Atom error feed with one entry, summary, and explanatory link for malformed input. The current live response to its own old malformed-ID example instead returned a `200` empty feed. The adapter therefore has to handle both documented Atom error feeds and a valid empty `200` feed; the latter is an `ok` zero-result source response, not a provider outage.

No `429`, `400`, large-page, concurrent-connection, or rate-limit-evasion probe was intentionally generated. The absence of rate/backoff headers in a few successful calls is not evidence that the documented three-second/single-connection limit can be relaxed. Provider HTTP errors, malformed XML, parser failures, timeouts, and a mocked `429`/`Retry-After` path remain mandatory tests.

## Product role and source boundary

| Source | Keep as its primary role | Do not make it do |
| --- | --- | --- |
| OpenAlex | Broad cross-disciplinary discovery, normalized work records, cited-by/referenced-work evidence, and the existing initial map relations | The only source of preprint-native abstract/category/update metadata. |
| Crossref | DOI-oriented publisher/depositor metadata, venue/container/date/type reconciliation | A complete or authoritative citation graph, or a preprint-only discovery source. |
| arXiv | Preprint identity, abstracts, authors, categories/cross-lists, original submission/last-update timestamps, optional DOI and journal reference | Citation/reference edges, citation-count ranking, paper-license inference, full-text mirroring, or a replacement for OpenAlex/Crossref. |

The candidate-pool merger should treat a normalized arXiv identifier and DOI as strong identities, retain all matching source IDs/ranks/query URLs/retrieval times, and preserve an OpenAlex primary ID and any existing real relationship evidence. A title/year/first-author match remains only a guarded review fallback. No arXiv-derived relation should be inserted into the initial graph merely because two records share an arXiv category.

## Windows and Electron integration risks

- Transport and packaging risk are low: the selected API is key-free HTTPS metadata, needs no native module, no separate daemon, no PDF browser automation, and no child process. It belongs in the existing Node-side literature-source path, behind the existing network permission and remote-metadata privacy setting, not in the renderer.
- XML is the material implementation risk. Atom namespace handling, optional elements, invalid provider output, and entity expansion are fundamentally different from the JSON adapters already present. Before parsing, impose a bounded raw-response size and reject DTD/entity declarations. Select and evaluate a maintained pure-JavaScript XML parser when this slice starts; do not prematurely lock a package in this evaluation.
- The API's legacy examples use HTTP URLs, while the verified endpoint works over HTTPS. Outbound requests and user-facing canonical links should use HTTPS where the target supports it. Treat any returned `http://arxiv.org/abs/...` identifier as data to normalize safely rather than allowing it to weaken the desktop application's navigation policy.
- A per-source endpoint queue must be process-wide, FIFO, abort-aware, and release its permit only after the response body is consumed or cancelled. It must enforce at least 3,000 milliseconds between request starts and one in-flight request. Multi-window Electron use and desktop tests must share that limiter; retry policy must never turn a transient failure into an immediate second request.
- Because the provider may change API behavior, every release needs two complementary packaged-app checks: a deterministic local Atom fixture that proves the asar adapter/parser path, and one separately opted-in bounded live metadata request. Tests must not depend on a live rate limit being hit.

## Atom parser implementation decision

- Adopt `@rgrove/parse-xml` `4.2.2` as an exact production dependency. The package is ISC-licensed, has zero runtime dependencies, requires Node 14 or newer, and the verified npm release was published on 2026-07-11. The upstream `v4.2.2` peeled commit checked for this decision is `03f09e1429eb4a564e046f1db1c632025b4e7de9`.
- Real arXiv Atom parsing succeeded under Node `22.13.1`, Node `23.10.0`, and Electron `37.10.3` from a Windows asar. The package is pure JavaScript and introduces no native binary or child process.
- Malformed XML and undefined internal or external named entities were rejected in the comparison run. A local external-entity sentinel file was not read. Rigorium still rejects every `DOCTYPE` or `ENTITY` declaration before parsing, because parser defaults are not the product security boundary.
- The adapter imposes the UTF-8 body limit, timeout, cancellation, root namespace validation, XML-depth limit, and entry-count limit before normalized papers leave the Node-side provider. The renderer never receives raw XML.

Rejected alternatives for this slice:

- `fast-xml-parser` `5.10.1` was active and MIT-licensed, but the tested configuration expanded an internal entity and brought six direct runtime dependencies.
- `@xmldom/xmldom` `0.9.10` was MIT-licensed and dependency-free, but returned a document after reporting some entity problems through `onError`, increasing the chance that a caller would forget to promote diagnostics to a hard failure.
- `txml` `6.0.0` did not preserve `&amp;` correctly in the real-feed comparison. `saxes` `6.0.0` was strict and streaming, but its registry maintenance signal was older and it was only a transitive dependency rather than an intentional product dependency.

## Proposed implementation boundary for the next slice

1. Add a dedicated `LiteratureSource` adapter with ID `arxiv`; add the global/project `enabled` setting, defaulting to `true`, with no credential field and no mandatory contact field.
2. Build one encoded `search_query` from the agent-created query. Map generic `fromYear`/`toYear` only to the documented `submittedDate` interval and label the resulting source coverage as arXiv submission-date filtering. Map generic relevance and date ranking explicitly; surface a limitation for generic citation-count ranking.
3. Limit the first request to the current Rigorium result budget, one page, one `start=0` request. Preserve the URL, source rank, retrieval time, total matches, and an honest coverage description in `ResearchSourceStatus`.
4. Normalize required Atom and optional arXiv extension fields into the existing `ResearchPaper`/`PaperIdentity` contract. Merge candidates by arXiv ID and DOI without overwriting existing source identities, and return no arXiv relation edges in this slice.
5. On an arXiv source error, retain successful OpenAlex/Crossref results and report partial coverage. Treat a successful zero-result Atom feed as successful zero results; parse an Atom error body only for a useful diagnostic.
6. Do not add a user-facing provider command. Natural-language research requests continue to select enabled sources; explicit UI remains reserved for state-changing actions such as a Zotero write or export.

## Verification gate before enabling it in a build

- Unit tests for query encoding, title phrase input, categories, GMT submitted-date boundaries, sorting, 0-based paging, and source-specific citation-sort limitation.
- Atom fixtures for normal entries, multiple categories/cross-listing, optional DOI/journal reference/affiliation/comment, empty successful feed, documented error feed, non-2xx response, malformed XML, DTD/entity rejection, over-size body, cancellation, and a mocked `429`/`Retry-After` outcome.
- Queue tests proving no two arXiv requests overlap, a minimum three-second start interval, abort while queued without overtaking an in-flight request, and no automatic immediate retry after an HTTP provider error.
- Candidate-pool tests for arXiv-ID and DOI merging, complete provenance retention, no accidental title-only destructive merge, and no invented citation/topic edges.
- Research Settings/UI tests for global versus project override, default enabled state, privacy-disabled behavior, and an arXiv-only failure yielding partial rather than failed coverage when a sibling succeeds.
- Run the deterministic packaged check after building Electron. `pnpm run desktop:verify-research` must prove that the adapter dynamically imported from `app.asar` parses the bundled Atom fixture; this is the stable parser/package regression gate.
- Run the controlled live packaged smoke separately for this increment and before a release candidate: in PowerShell, set `RIGORIUM_VERIFY_ARXIV_LIVE=1` only for the `pnpm run desktop:verify-research` process. It uses the same production adapter, the official default endpoint, one `limit=1` first-page metadata request, and the production 3-second/single-connection gate. It must return an `ok` source status, a non-zero result count, and a normalized arXiv ID/title. It must not retrieve a PDF or introduce renderer access.
- Verify that no external browser opens and no credential/remote-content path is introduced, then run the existing desktop regression and NSIS packaging verification.

## Non-decisions

- This record does not adopt OAI-PMH, bulk metadata access, PDF/full-text retrieval, arXiv source downloads, a third-party arXiv SDK/MCP, a citation parser, a graph library, or a particular XML library.
- It does not infer venue acceptance, peer-review status, open-license status, or publication status from an arXiv record.
- It does not schedule automatic background polling. Any future map-maintenance work must reuse the source limiter and remain separately approved and verified.
