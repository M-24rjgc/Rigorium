import assert from "node:assert/strict";
import test from "node:test";
import { createOpenReviewSource } from "../../src/research/literature/openReviewSource.js";
import { DEFAULT_RESEARCH_SETTINGS } from "../../src/research/settings.js";

const acceptedVenueId = "ICLR.cc/2024/Conference/Accept (Poster)";

test("OpenReview venue source records official accepted evidence from an explicit venue ID", async () => {
  const requested: string[] = [];
  const source = createOpenReviewSource({
    endpoint: "https://openreview.test/notes",
    fetchImpl: async (input) => {
      requested.push(String(input));
      return jsonResponse({
        count: 1,
        notes: [{
          id: "openreview-note-1",
          pdate: Date.UTC(2024, 4, 1) / 1_000,
          content: {
            title: { value: "Venue constrained graph learning" },
            authors: { value: ["Ada Researcher"] },
            abstract: { value: "A controlled OpenReview fixture." },
            venue: { value: "ICLR 2024 poster" },
            venueid: { value: acceptedVenueId },
          },
        }],
      });
    },
  });

  const result = await source.search({
    query: "graph learning",
    limit: 5,
    sort: "relevance",
    sourceIds: ["openreview"],
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
  }, { now: () => new Date("2026-07-23T00:00:00.000Z") });

  assert.equal(requested.length, 1);
  const query = new URL(requested[0]!);
  assert.equal(query.searchParams.get("content.venueid"), acceptedVenueId);
  assert.equal(result.source.status, "ok");
  assert.deepEqual(result.source.applied?.venueSet, {
    id: "iclr-2024-accepted",
    name: "ICLR 2024 accepted posters",
    constraintIds: ["iclr-main"],
    requestedStatuses: ["accepted"],
    enforcement: "official",
  });
  assert.deepEqual(result.papers[0]?.venueEvidence, [{
    sourceId: "openreview",
    evidence: "official",
    venue: "ICLR 2024 poster",
    year: 2024,
    track: "poster",
    status: "accepted",
    officialVenueId: acceptedVenueId,
  }]);
});

test("OpenReview is enabled by default but remains dormant without an explicit official venue ID", async () => {
  assert.equal(DEFAULT_RESEARCH_SETTINGS.literature.sources.openreview?.enabled, true);
  const source = createOpenReviewSource({
    fetchImpl: async () => {
      throw new Error("OpenReview must not be called without an official venue ID.");
    },
  });
  const result = await source.search({
    query: "graph learning",
    limit: 5,
    sort: "relevance",
    sourceIds: ["openreview"],
    venueSet: {
      id: "iclr-2024",
      name: "ICLR 2024",
      venues: [{ id: "iclr-main", name: "ICLR", year: 2024, status: "accepted" }],
    },
  });
  assert.equal(result.source.status, "disabled");
  assert.match(result.source.coverage, /No official OpenReview venue identifier/i);
});

test("OpenReview preserves an HTTP failure without retaining a remote challenge body", async () => {
  const source = createOpenReviewSource({
    endpoint: "https://openreview.test/notes",
    fetchImpl: async () => jsonResponse({
      message: "Challenge verification required",
      challengeUrl: "https://openreview.test/challenge?one-time=do-not-persist",
    }, 403),
  });

  const result = await source.search({
    query: "graph learning",
    limit: 5,
    sort: "relevance",
    sourceIds: ["openreview"],
    venueSet: {
      id: "iclr-2024",
      name: "ICLR 2024",
      venues: [{
        id: "iclr-main",
        name: "ICLR",
        year: 2024,
        status: "accepted",
        openReviewVenueId: acceptedVenueId,
      }],
    },
  });

  assert.equal(result.source.status, "error");
  assert.match(result.source.error ?? "", /HTTP 403/);
  assert.doesNotMatch(result.source.error ?? "", /challenge|one-time|persist/i);
});

test("OpenReview preserves an explicit submission-stage constraint without treating it as accepted", async () => {
  const source = createOpenReviewSource({
    endpoint: "https://openreview.test/notes",
    fetchImpl: async () => jsonResponse({
      count: 1,
      notes: [{
        id: "openreview-submission-note",
        content: {
          title: { value: "Submission-stage paper" },
          venue: { value: "ICLR 2024 submission" },
        },
      }],
    }),
  });
  const result = await source.search({
    query: "graph learning",
    limit: 5,
    sort: "relevance",
    sourceIds: ["openreview"],
    venueSet: {
      id: "iclr-2024-submissions",
      name: "ICLR 2024 submissions",
      venues: [{
        id: "iclr-main",
        name: "ICLR",
        year: 2024,
        status: "submission",
        openReviewVenueId: "ICLR.cc/2024/Conference/Submission",
      }],
    },
  });

  assert.equal(result.papers[0]?.venueEvidence?.[0]?.status, "submission");
  assert.equal(result.papers[0]?.identity.other?.openreviewStatus, "submission");
  assert.equal(result.papers[0]?.identity.other?.openreviewAccepted, undefined);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
