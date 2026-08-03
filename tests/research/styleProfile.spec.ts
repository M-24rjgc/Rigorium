import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VenueCorpus } from "../../src/research/manuscript/style/VenueCorpus.js";
import { StyleProfileStore, validateStyleProfile } from "../../src/research/manuscript/style/StyleProfileStore.js";
import type { StyleProfile } from "../../src/research/manuscript/style/types.js";
import { createVenueCorpusTool } from "../../src/tool/builtin/venueCorpus.js";
import type { VenueCorpusToolResult } from "../../src/tool/builtin/venueCorpus.js";

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "rigorium-style-"));
}

function makeProfile(venue: string, overrides: Partial<StyleProfile> = {}): StyleProfile {
  return {
    venue,
    computedAt: "2026-08-03T00:00:00.000Z",
    learnedFrom: ["p1", "p2"],
    storyArc: [
      {
        phase: "intro-motivation",
        function: "Open with the problem and its importance",
        convention: "First paragraph: concrete motivation; second: gap.",
        typicalParagraphs: 2,
      },
    ],
    sentenceTemplates: [
      {
        slot: "gap-statement",
        template: "Despite <progress>, <gap> remains <open>.",
        position: "intro, paragraph 2",
        examples: ["Despite rapid progress in X, Y remains poorly understood."],
      },
    ],
    paragraphPatterns: [
      { name: "claim-evidence-explanation", structure: ["claim", "evidence", "explanation"], transition: "This motivates..." },
    ],
    figureConventions: [
      {
        figureType: "data",
        styleNotes: "serif fonts, muted palette, no gridlines",
        captionPattern: "What is shown. How it was produced. Takeaway.",
        renderingApproach: "matplotlib, vector PDF",
      },
    ],
    latexConventions: {
      packages: ["amsmath", "booktabs"],
      notation: "bold for vectors",
      environments: "theorem, lemma",
      citationStyle: "parenthetical, dense in intro",
    },
    writingVoice: "Direct, hedged claims, minimal adjectives.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VenueCorpus
// ---------------------------------------------------------------------------

test("VenueCorpus: add, dedup, list, remove round-trip", async () => {
  const projectRoot = createTempProject();
  try {
    const corpus = new VenueCorpus({ projectRoot });
    await corpus.addPaper({
      paperId: "iclr-2025-best",
      title: "Best Paper",
      venue: "iclr",
      year: 2025,
      selection: "best_paper",
      source: "openreview",
      pdfPath: "/tmp/p.pdf",
    });
    await corpus.addPaper({
      paperId: "iclr-2025-high",
      title: "High Score",
      venue: "iclr",
      year: 2025,
      selection: "high_score",
      source: "openreview",
    });
    // Same id updates, does not duplicate.
    await corpus.addPaper({
      paperId: "iclr-2025-best",
      title: "Best Paper v2",
      venue: "iclr",
      year: 2025,
      selection: "best_paper",
      source: "openreview",
    });
    assert.equal(await corpus.size(), 2);

    const reloaded = new VenueCorpus({ projectRoot });
    const papers = await reloaded.listPapers();
    assert.equal(papers.length, 2);
    assert.equal(papers.find((paper) => paper.paperId === "iclr-2025-best")?.title, "Best Paper v2");

    assert.equal(await reloaded.removePaper("iclr-2025-best"), true);
    assert.equal(await reloaded.removePaper("nope"), false);
    assert.equal(await reloaded.size(), 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("VenueCorpus: per-venue eviction — collecting venue B never evicts venue A", async () => {
  const projectRoot = createTempProject();
  try {
    const corpus = new VenueCorpus({ projectRoot, maxPapers: 3 });
    for (let i = 0; i < 3; i += 1) {
      await corpus.addPaper({
        paperId: `iclr-${i}`,
        title: `ICLR paper ${i}`,
        venue: "iclr",
        year: 2025,
        selection: "high_score",
        source: "openreview",
      });
    }
    // Third venue-A paper pushes the venue-A cap (3) — the oldest is evicted.
    const { evicted } = await corpus.addPaper({
      paperId: "iclr-3",
      title: "ICLR paper 3",
      venue: "iclr",
      year: 2025,
      selection: "high_score",
      source: "openreview",
    });
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0]!.paperId, "iclr-0", "oldest same-venue paper is evicted first");

    // Collecting for a second venue must NOT touch venue A's papers.
    const other = await corpus.addPaper({
      paperId: "icml-1",
      title: "ICML paper 1",
      venue: "icml",
      year: 2025,
      selection: "best_paper",
      source: "openreview",
    });
    assert.equal(other.evicted.length, 0, "cross-venue add must not evict");
    const papers = await corpus.listPapers();
    assert.equal(papers.filter((paper) => paper.venue === "iclr").length, 3);
    assert.equal(papers.filter((paper) => paper.venue === "icml").length, 1);
    assert.ok(papers.some((paper) => paper.paperId === "iclr-3"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// StyleProfileStore
// ---------------------------------------------------------------------------

test("StyleProfileStore: save, supersede, get, list", async () => {
  const projectRoot = createTempProject();
  try {
    const store = new StyleProfileStore({ projectRoot });
    const first = await store.save(makeProfile("iclr"));
    assert.equal(first.superseded, false);
    assert.equal(first.saved.learnedFrom.length, 2);

    const second = await store.save(makeProfile("iclr", { writingVoice: "Revised voice." }));
    assert.equal(second.superseded, true);

    const reloaded = new StyleProfileStore({ projectRoot });
    const profile = await reloaded.get("iclr");
    assert.equal(profile?.writingVoice, "Revised voice.");
    const list = await reloaded.list();
    assert.equal(list.length, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("validateStyleProfile: rejects malformed profiles", () => {
  assert.equal(validateStyleProfile(makeProfile("iclr")), true);
  assert.equal(validateStyleProfile({ ...makeProfile("iclr"), venue: "" }), false);
  assert.equal(validateStyleProfile({ ...makeProfile("iclr"), computedAt: 42 }), false);
  assert.equal(validateStyleProfile({ ...makeProfile("iclr"), sentenceTemplates: "nope" }), false);
  assert.equal(validateStyleProfile(null), false);
});

// ---------------------------------------------------------------------------
// venue_corpus tool
// ---------------------------------------------------------------------------

function toolContext(projectRoot: string) {
  return { cwd: projectRoot, sessionId: "s1", turnId: "t1", abortSignal: undefined, now: () => new Date() } as never;
}

test("tool: paper_add + papers_list round-trip", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createVenueCorpusTool();
    await tool.execute(
      {
        action: "paper_add",
        paper: {
          paperId: "neurips-2025-best",
          title: "A NeurIPS Best Paper",
          venue: "neurips",
          year: 2025,
          selection: "best_paper",
          source: "openreview",
          pdfPath: "/tmp/neurips.pdf",
        },
      },
      toolContext(projectRoot),
    );
    const result = (await tool.execute(
      { action: "papers_list", venue: "neurips" },
      toolContext(projectRoot),
    )) as unknown as { data: Extract<VenueCorpusToolResult, { action: "papers_list" }> };
    assert.equal(result.data.papers.length, 1);
    assert.equal(result.data.papers[0]!.selection, "best_paper");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("tool: style_save + style_get round-trip with validation", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createVenueCorpusTool();
    const saveResult = (await tool.execute(
      { action: "style_save", profile: makeProfile("jmlr") },
      toolContext(projectRoot),
    )) as unknown as { data: Extract<VenueCorpusToolResult, { action: "style_save" }> };
    assert.equal(saveResult.data.superseded, false);
    assert.equal(saveResult.data.learnedFromCount, 2);

    const getResult = (await tool.execute(
      { action: "style_get", venue: "jmlr" },
      toolContext(projectRoot),
    )) as unknown as { data: Extract<VenueCorpusToolResult, { action: "style_get" }> };
    assert.equal(getResult.data.profile?.venue, "jmlr");
    assert.equal(getResult.data.profile?.sentenceTemplates[0]?.slot, "gap-statement");

    // Malformed profiles are rejected.
    await assert.rejects(
      tool.execute(
        { action: "style_save", profile: { venue: "x", computedAt: 42 } as never },
        toolContext(projectRoot),
      ),
      /Invalid style profile/,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("tool: style_save supersedes previous profile for the same venue", async () => {
  const projectRoot = createTempProject();
  try {
    const tool = createVenueCorpusTool();
    await tool.execute({ action: "style_save", profile: makeProfile("icml") }, toolContext(projectRoot));
    const second = (await tool.execute(
      { action: "style_save", profile: makeProfile("icml", { writingVoice: "v2" }) },
      toolContext(projectRoot),
    )) as unknown as { data: Extract<VenueCorpusToolResult, { action: "style_save" }> };
    assert.equal(second.data.superseded, true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
