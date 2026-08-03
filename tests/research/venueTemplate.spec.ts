import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VenueTemplateRegistry } from "../../src/research/manuscript/templates/VenueTemplateRegistry.js";
import { resolveTemplateSources } from "../../src/research/manuscript/templates/templateResolver.js";
import { BUILTIN_VENUES, BUILTIN_VENUE_IDS } from "../../src/research/manuscript/templates/venueRegistry.js";
import { createVenueTemplateTool } from "../../src/tool/builtin/venueTemplate.js";
import type { VenueTemplateToolResult } from "../../src/tool/builtin/venueTemplate.js";

// ---------------------------------------------------------------------------
// venueRegistry
// ---------------------------------------------------------------------------

test("registry: built-in catalog covers major conferences and journals", () => {
  assert.ok(BUILTIN_VENUE_IDS.includes("iclr"));
  assert.ok(BUILTIN_VENUE_IDS.includes("icml"));
  assert.ok(BUILTIN_VENUE_IDS.includes("neurips"));
  assert.ok(BUILTIN_VENUE_IDS.includes("acl"));
  assert.ok(BUILTIN_VENUE_IDS.includes("cvpr"));
  assert.ok(BUILTIN_VENUE_IDS.includes("jmlr"));
  assert.ok(BUILTIN_VENUE_IDS.includes("tmlr"));
  assert.ok(BUILTIN_VENUE_IDS.includes("tpami"));
  assert.ok(BUILTIN_VENUE_IDS.includes("nature_mi"));
  assert.ok(BUILTIN_VENUE_IDS.includes("pnas"));
  const conferences = BUILTIN_VENUES.filter((venue) => venue.kind === "conference");
  const journals = BUILTIN_VENUES.filter((venue) => venue.kind === "journal");
  assert.ok(conferences.length >= 8, `conferences=${conferences.length}`);
  assert.ok(journals.length >= 6, `journals=${journals.length}`);
});

test("registry: ICLR keeps its verified 2026 pin", () => {
  const iclr = BUILTIN_VENUES.find((venue) => venue.id === "iclr")!;
  const verified = iclr.sources.filter((source) => source.verified);
  assert.equal(verified.length, 1);
  assert.equal(verified[0]!.year, 2026);
  assert.match(verified[0]!.archiveSha256 ?? "", /^sha256:/);
});

// ---------------------------------------------------------------------------
// templateResolver
// ---------------------------------------------------------------------------

test("resolver: exact-year match ranks first, no fallback flag", () => {
  const iclr = BUILTIN_VENUES.find((venue) => venue.id === "iclr")!;
  const resolution = resolveTemplateSources(iclr, 2026);
  assert.equal(resolution.fallbackRequired, false);
  assert.equal(resolution.candidates[0]!.sourceYear, 2026);
  assert.equal(resolution.candidates[0]!.yearAdjusted, false);
  assert.equal(resolution.candidates[0]!.source.verified, true);
});

test("resolver: unverified target year falls back to prior years explicitly", () => {
  const iclr = BUILTIN_VENUES.find((venue) => venue.id === "iclr")!;
  const resolution = resolveTemplateSources(iclr, 2027);
  assert.equal(resolution.fallbackRequired, true);
  const fallback = resolution.candidates.find((candidate) => candidate.yearAdjusted);
  assert.ok(fallback, "must offer a year-adjusted fallback");
  assert.equal(fallback!.sourceYear, 2026);
  assert.match(fallback!.rationale, /2027/);
  assert.match(fallback!.rationale, /adjust the year token/i);
});

test("resolver: evergreen journal sources never require fallback", () => {
  const jmlr = BUILTIN_VENUES.find((venue) => venue.id === "jmlr")!;
  const resolution = resolveTemplateSources(jmlr, undefined);
  assert.equal(resolution.fallbackRequired, false);
  assert.equal(resolution.candidates[0]!.yearAdjusted, false);
});

// ---------------------------------------------------------------------------
// VenueTemplateRegistry (project-level extension)
// ---------------------------------------------------------------------------

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "rigorium-venues-"));
}

test("registry: project custom venues extend the built-in catalog", async () => {
  const projectRoot = createTempProject();
  try {
    const registry = new VenueTemplateRegistry({ projectRoot });
    const before = await registry.listVenues();
    assert.ok(!before.some((venue) => venue.id === "my-journal"));

    const custom = {
      id: "my-journal",
      kind: "journal" as const,
      displayName: "My Lab Journal",
      sources: [
        {
          officialPageUrl: "https://example.com/author-kit",
          verified: false,
        },
      ],
    };
    registry.register(custom);
    await registry.save([custom]);

    const reloaded = new VenueTemplateRegistry({ projectRoot });
    const venues = await reloaded.listVenues();
    assert.ok(venues.some((venue) => venue.id === "my-journal"), "custom venue must survive reload");
    const resolution = await reloaded.resolve("my-journal", 2026);
    assert.equal(resolution?.candidates[0]?.source.officialPageUrl, "https://example.com/author-kit");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// venue_template tool
// ---------------------------------------------------------------------------

function toolContext(projectRoot: string) {
  return {
    cwd: projectRoot,
    sessionId: "s1",
    turnId: "t1",
    abortSignal: undefined,
    now: () => new Date(),
  } as never;
}

test("tool: list returns built-in venues with summary", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createVenueTemplateTool();
    const result = (await tool.execute(
      { action: "list" },
      toolContext(projectRoot),
    )) as unknown as { data: Extract<VenueTemplateToolResult, { action: "list" }> };
    assert.equal(result.data.action, "list");
    const venues = result.data.venues;
    assert.ok(venues.length >= 14);
    const iclr = venues.find((venue) => venue.id === "iclr")!;
    assert.equal(iclr.verifiedSources, 1);
    assert.ok(iclr.anonymousSubmission);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("tool: list filters by id/name substring", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createVenueTemplateTool();
    const result = (await tool.execute(
      { action: "list", filter: "learn" },
      toolContext(projectRoot),
    )) as unknown as { data: Extract<VenueTemplateToolResult, { action: "list" }> };
    const ids = result.data.venues.map((venue) => venue.id);
    assert.ok(ids.includes("iclr") || ids.includes("icml") || ids.includes("colm"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("tool: resolve reports year fallback for unverified target year", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createVenueTemplateTool();
    const result = (await tool.execute(
      { action: "resolve", venue: "iclr", year: 2027 },
      toolContext(projectRoot),
    )) as unknown as { data: Extract<VenueTemplateToolResult, { action: "resolve" }> };
    assert.equal(result.data.action, "resolve");
    assert.equal(result.data.resolution.fallbackRequired, true);
    const text = result.data.resolution.candidates.map((c) => c.rationale).join(" ");
    assert.match(text, /adjust the year token/i);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("tool: resolve rejects unknown venues", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createVenueTemplateTool();
    await assert.rejects(
      tool.execute({ action: "resolve", venue: "no-such-venue", year: 2026 }, toolContext(projectRoot)),
      /Unknown venue/,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("tool: pin persists a verified source into the project registry", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createVenueTemplateTool();
    const result = (await tool.execute(
      {
        action: "pin",
        venue: "icml",
        year: 2025,
        source: {
          officialPageUrl: "https://icml.cc",
          archiveUrl: "https://media.icml.cc/Conferences/ICML2025/Styles/icml2025.zip",
          archiveSha256: "sha256:deadbeef",
          requiredFiles: ["icml2025.sty"],
        },
      },
      toolContext(projectRoot),
    )) as unknown as { data: Extract<VenueTemplateToolResult, { action: "pin" }> };
    assert.equal(result.data.action, "pin");
    assert.equal(result.data.pinned.verified, true);

    // A fresh registry instance must see the pinned source first.
    const reloaded = new VenueTemplateRegistry({ projectRoot });
    const resolution = await reloaded.resolve("icml", 2025);
    const top = resolution!.candidates[0]!;
    assert.equal(top.source.verified, true);
    assert.equal(top.source.archiveSha256, "sha256:deadbeef");
    assert.equal(top.sourceYear, 2025);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("tool: pin merges with built-in sources — year fallback survives", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createVenueTemplateTool();
    await tool.execute(
      {
        action: "pin",
        venue: "iclr",
        year: 2027,
        source: {
          officialPageUrl: "https://iclr.cc/Conferences/2027/AuthorGuide",
          archiveUrl: "https://example.com/iclr2027.zip",
          archiveSha256: "sha256:abcdef",
        },
      },
      toolContext(projectRoot),
    );

    // The pin leads for its own year…
    const reloaded = new VenueTemplateRegistry({ projectRoot });
    const for2027 = await reloaded.resolve("iclr", 2027);
    assert.equal(for2027!.candidates[0]!.source.archiveSha256, "sha256:abcdef");
    assert.equal(for2027!.candidates[0]!.source.verified, true);

    // …and prior-year fallback must still work (2026 verified source kept).
    const for2026 = await reloaded.resolve("iclr", 2026);
    assert.equal(for2026!.fallbackRequired, false);
    const top2026 = for2026!.candidates[0]!;
    assert.equal(top2026.source.year, 2026);
    assert.equal(top2026.source.verified, true);
    assert.equal(top2026.yearAdjusted, false, "2026 is an exact match — the built-in source survived the pin");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
