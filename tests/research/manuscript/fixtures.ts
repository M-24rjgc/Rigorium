import type { ResearchPaper, ZoteroLibraryItem } from "../../../src/research/types.js";

export const SYNTHETIC_NOW = new Date("2026-07-25T04:05:06.000Z");

export function syntheticZoteroItem(overrides: Partial<ZoteroLibraryItem> = {}): ZoteroLibraryItem {
  return {
    key: "SYNTH0001",
    itemType: "journalArticle",
    title: "Synthetic calibration fixture",
    creators: ["Ada Lovelace"],
    date: "2026",
    year: 2026,
    doi: "10.0000/synthetic.1",
    url: "https://example.invalid/synthetic-1",
    tags: ["synthetic-fixture"],
    collectionKeys: [],
    identity: { zoteroKey: "SYNTH0001", doi: "10.0000/synthetic.1" },
    ...overrides,
  };
}

export function syntheticPaper(id: string, title: string): ResearchPaper {
  return {
    id,
    identity: { other: { synthetic: id } },
    title,
    authors: ["Synthetic Author"],
    year: 2026,
    citedByCount: 0,
    topics: [],
    referencedWorkIds: [],
    sourceId: "synthetic",
    sourceIds: ["synthetic"],
    provenance: [{ sourceId: "synthetic", sourceRecordId: id, rank: 1, retrievedAt: SYNTHETIC_NOW.toISOString() }],
  };
}

export function minimalLatex(body = "Synthetic fixture only."): string {
  return `\\documentclass{article}
\\begin{document}
${body}
\\label{pilotdeck-main-matter-end}
\\end{document}`;
}

