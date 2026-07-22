import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_RESEARCH_SETTINGS, writeResearchSettings } from "../../../src/research/settings.js";
import { createLiteratureSearchTool } from "../../../src/tool/builtin/literatureSearch.js";

const acceptedVenueId = "ICLR.cc/2024/Conference/Accept (Poster)";

test("literature_search keeps metadata matches while preserving official OpenReview acceptance evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-venue-set-"));
  const pilotHome = join(root, "pilot-home");
  await writeVenueSettings(pilotHome);
  let openReviewRequests = 0;
  const tool = createLiteratureSearchTool({
    endpoint: "https://openalex.test/works",
    openReviewEndpoint: "https://openreview.test/notes",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("openreview.test")) {
        openReviewRequests += 1;
        return jsonResponse({
          count: 1,
          notes: [{
            id: "official-accepted-note",
            content: {
              title: { value: "Official accepted graph learning paper" },
              authors: { value: ["Official Author"] },
              venue: { value: "ICLR 2024 poster" },
              venueid: { value: acceptedVenueId },
            },
          }],
        });
      }
      return jsonResponse({
        meta: { count: 2 },
        results: [
          openAlexWork("https://openalex.org/W-iclr", "Metadata ICLR graph learning", "ICLR 2024 poster"),
          openAlexWork("https://openalex.org/W-neurips", "Other venue graph learning", "NeurIPS 2024"),
        ],
      });
    },
  });

  const result = await tool.execute({
    query: "graph learning",
    limit: 5,
    queryVariants: [{ query: "GNN", category: "abbreviation" }],
    venueSet: {
      id: "iclr-2024-accepted",
      name: "ICLR 2024 accepted posters",
      venues: [{
        id: "iclr-main",
        name: "ICLR",
        year: 2024,
        track: "poster",
        status: "accepted",
        openReviewVenueId: acceptedVenueId,
      }],
    },
  }, {
    cwd: join(root, "project"),
    env: { PILOT_HOME: pilotHome },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  } as any);

  assert.deepEqual(result.data?.plan.venueSet, {
    id: "iclr-2024-accepted",
    name: "ICLR 2024 accepted posters",
    venues: [{
      id: "iclr-main",
      name: "ICLR",
      year: 2024,
      track: "poster",
      status: "accepted",
      openReviewVenueId: acceptedVenueId,
    }],
  });
  assert.equal(result.data?.papers.some((paper) => paper.title === "Other venue graph learning"), false);
  assert.equal(openReviewRequests, 1);
  assert.deepEqual(
    result.data?.queryAudit?.filter((source) => source.id === "openreview").map((source) => source.queryVariantId),
    ["primary"],
  );
  const metadataPaper = result.data?.papers.find((paper) => paper.title === "Metadata ICLR graph learning");
  assert.deepEqual(metadataPaper?.venueEvidence, [{
    sourceId: "openalex",
    evidence: "metadata",
    venue: "ICLR 2024 poster",
    year: 2024,
    track: "poster",
    status: "unknown",
  }]);
  const officialPaper = result.data?.papers.find((paper) => paper.title === "Official accepted graph learning paper");
  assert.equal(officialPaper?.venueEvidence?.[0]?.evidence, "official");
  assert.equal(officialPaper?.venueEvidence?.[0]?.status, "accepted");
  const openAlex = result.data?.sources.find((source) => source.id === "openalex");
  assert.equal(openAlex?.partial, true);
  assert.equal(openAlex?.applied?.venueSet?.enforcement, "metadata");
  assert.match(openAlex?.warnings?.join(" ") ?? "", /not inferred/i);
});

test("literature_search retains non-official venue metadata if OpenReview fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-venue-set-openreview-failure-"));
  const pilotHome = join(root, "pilot-home");
  await writeVenueSettings(pilotHome);
  const tool = createLiteratureSearchTool({
    endpoint: "https://openalex.test/works",
    openReviewEndpoint: "https://openreview.test/notes",
    fetchImpl: async (input) => {
      if (String(input).includes("openreview.test")) return jsonResponse({ error: "unavailable" }, 400);
      return jsonResponse({
        meta: { count: 1 },
        results: [openAlexWork("https://openalex.org/W-retained", "Retained metadata paper", "ICLR 2024 poster")],
      });
    },
  });

  const result = await tool.execute({
    query: "graph learning",
    venueSet: {
      id: "iclr-2024-accepted",
      name: "ICLR 2024 accepted posters",
      venues: [{
        id: "iclr-main",
        name: "ICLR",
        year: 2024,
        status: "accepted",
        openReviewVenueId: acceptedVenueId,
      }],
    },
  }, {
    cwd: join(root, "project"),
    env: { PILOT_HOME: pilotHome },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  } as any);

  assert.equal(result.data?.coverage.status, "partial");
  assert.equal(result.data?.papers.length, 1);
  assert.equal(result.data?.papers[0]?.venueEvidence?.[0]?.status, "unknown");
  assert.deepEqual(result.data?.coverage.successfulSourceIds, ["openalex"]);
  assert.deepEqual(result.data?.coverage.failedSourceIds, ["openreview"]);
});

test("literature_search never uses an arXiv preprint to claim an accepted venue decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-venue-set-arxiv-"));
  const pilotHome = join(root, "pilot-home");
  await writeArxivOnlyVenueSettings(pilotHome);
  const tool = createLiteratureSearchTool({
    arxivEndpoint: "https://arxiv.test/api/query",
    arxivMinimumIntervalMs: 1,
    fetchImpl: async () => arxivResponse(),
  });

  const result = await tool.execute({
    query: "graph learning",
    venueSet: {
      id: "iclr-2024-accepted",
      name: "ICLR 2024 accepted posters",
      venues: [{ id: "iclr-main", name: "ICLR", year: 2024, status: "accepted" }],
    },
  }, {
    cwd: join(root, "project"),
    env: { PILOT_HOME: pilotHome },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  } as any);

  assert.equal(result.data?.papers.length, 0);
  const arxiv = result.data?.sources.find((source) => source.id === "arxiv");
  assert.equal(arxiv?.status, "ok");
  assert.equal(arxiv?.partial, true);
  assert.equal(arxiv?.applied?.venueSet?.enforcement, "metadata");
  assert.match(arxiv?.warnings?.join(" ") ?? "", /not inferred/i);
  assert.equal(result.data?.sources.find((source) => source.id === "openreview")?.status, "disabled");
});

test("literature_search rejects conflicting or unsafe venue-set state before sources run", async () => {
  const tool = createLiteratureSearchTool({
    fetchImpl: async () => {
      throw new Error("source should not run after invalid venue input");
    },
  });
  await assert.rejects(
    tool.execute({
      query: "graph learning",
      venueSet: {
        id: "bad-venue-set",
        name: "Bad venue set",
        venues: [{
          id: "main",
          name: "ICLR",
          status: "accepted",
          accepted: false,
          openReviewVenueId: "ICLR.cc/2024/Conference?unsafe=yes",
        }],
      },
    }, { cwd: join(tmpdir(), "rigorium-invalid-venue-set") } as any),
    /Invalid venue set:.*conflicting status and accepted/i,
  );
  await assert.rejects(
    tool.execute({
      query: "graph learning",
      venueSet: {
        id: "bad-venue-set",
        name: "Bad venue set",
        venues: [{
          id: "main",
          name: "ICLR",
          status: "accepted",
          openReviewVenueId: "ICLR.cc/2024/Conference?unsafe=yes",
        }],
      },
    }, { cwd: join(tmpdir(), "rigorium-invalid-openreview-venue") } as any),
    /Invalid venue set:.*openReviewVenueId contains unsupported/i,
  );
});

async function writeVenueSettings(pilotHome: string): Promise<void> {
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          openalex: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openalex, enabled: true },
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: false },
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: false },
          openreview: { enabled: true },
        },
      },
    },
  });
}

async function writeArxivOnlyVenueSettings(pilotHome: string): Promise<void> {
  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        sources: {
          openalex: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.openalex, enabled: false },
          arxiv: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv, enabled: true },
          crossref: { ...DEFAULT_RESEARCH_SETTINGS.literature.sources.crossref, enabled: false },
          openreview: { enabled: true },
        },
      },
    },
  });
}

function openAlexWork(id: string, title: string, venue: string) {
  return {
    id,
    title,
    publication_year: 2024,
    publication_date: "2024-05-01",
    type: "proceedings-article",
    cited_by_count: 4,
    authorships: [],
    primary_location: {
      landing_page_url: `https://doi.org/${id.split("/").at(-1)}`,
      source: { display_name: venue },
    },
    open_access: { is_oa: true },
    topics: [],
    referenced_works: [],
    ids: { openalex: id },
    abstract_inverted_index: null,
    keywords: [],
    primary_topic: null,
    is_paratext: false,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function arxivResponse(): Response {
  const xml = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<feed xmlns=\"http://www.w3.org/2005/Atom\" xmlns:arxiv=\"http://arxiv.org/schemas/atom\" xmlns:opensearch=\"http://a9.com/-/spec/opensearch/1.1/\">",
    "<title>ArXiv query</title><id>http://arxiv.org/api/query</id><updated>2024-01-20T00:00:00Z</updated>",
    "<opensearch:totalResults>1</opensearch:totalResults>",
    "<entry><id>http://arxiv.org/abs/2401.12345v2</id><updated>2024-01-20T00:00:00Z</updated>",
    "<published>2024-01-01T00:00:00Z</published><title>Unverified preprint</title>",
    "<summary>There is no conference decision in this record.</summary><author><name>Preprint Author</name></author>",
    "<arxiv:primary_category term=\"cs.AI\" scheme=\"http://arxiv.org/schemas/atom\"/><category term=\"cs.AI\" scheme=\"http://arxiv.org/schemas/atom\"/></entry>",
    "</feed>",
  ].join("");
  return new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8" } });
}
