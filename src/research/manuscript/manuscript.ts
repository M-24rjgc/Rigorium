import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactParent,
} from "../artifacts/index.js";
import type {
  CreateManuscriptVersionInput,
  ManuscriptTarget,
  ManuscriptVersionArtifact,
} from "./types.js";
import { auditSectionGeneration, validateSectionCollection } from "./sections.js";
import {
  hashText,
  requireCitationKey,
  requireIdentifier,
  requireLatex,
  requirePositiveInteger,
  requireText,
  stripLatexComments,
  uniqueSorted,
} from "./validation.js";

export function createManuscriptVersion(input: CreateManuscriptVersionInput): ManuscriptVersionArtifact {
  const title = requireText(input.title, "manuscript title", 2_000);
  const latex = requireLatex(input.latex);
  const activeLatex = stripLatexComments(latex);
  validateDocument(activeLatex);
  const target = normalizeTarget(input.target);
  if (input.template !== undefined) {
    if (target.venue !== "iclr" || input.template.provider !== "iclr" || input.template.conferenceYear !== target.conferenceYear) {
      throw new TypeError("Template pin does not match the manuscript target.");
    }
  }
  const sections = validateSectionCollection(input.sections);
  const sectionAudits = sections.map(auditSectionGeneration);
  const citationKeys = new Set(input.citationSet?.payload.citationKeys ?? []);
  if (input.citationSet) {
    const unknown = sections.flatMap((section) => section.statements.flatMap((statement) => statement.citationKeys))
      .find((key) => !citationKeys.has(key));
    if (unknown) throw new TypeError(`Section contract references citation key ${unknown}, which is absent from CitationSet.`);
  }
  const figureRefs = (input.figureTables ?? []).map(toResearchArtifactRef);
  const figureKeys = new Set(figureRefs.map((ref) => `${ref.artifactId}@${ref.revision}`));
  const missingFigure = sections.flatMap((section) => section.statements.flatMap((statement) => statement.figureTableRefs))
    .find((ref) => !figureKeys.has(`${ref.artifactId}@${ref.revision}`));
  if (missingFigure) throw new TypeError(`Section contract references unavailable FigureTable ${missingFigure.artifactId}@${missingFigure.revision}.`);

  const bibliographyIndex = bibliographyPosition(activeLatex);
  const appendixIndex = activeLatex.search(/\\appendix\b/u);
  const appendixEnabled = appendixIndex >= 0;
  const appendix = Object.freeze({
    enabled: appendixEnabled,
    commandPresent: appendixEnabled,
    afterBibliography: !appendixEnabled || (bibliographyIndex >= 0 && appendixIndex > bibliographyIndex),
  });
  if (appendixEnabled && !appendix.afterBibliography) {
    throw new TypeError("The appendix must begin after the bibliography boundary.");
  }

  const parents: ResearchArtifactParent[] = [];
  if (input.citationSet) parents.push({ relation: "uses", artifact: toResearchArtifactRef(input.citationSet) });
  for (const figure of input.figureTables ?? []) parents.push({ relation: "uses", artifact: toResearchArtifactRef(figure) });
  for (const evidence of input.evidencePacks ?? []) parents.push({ relation: "supports", artifact: toResearchArtifactRef(evidence) });
  if (input.supersedes) parents.push({ relation: "supersedes", artifact: toResearchArtifactRef(input.supersedes) });
  const artifactId = input.artifactId ?? input.supersedes?.artifactId;
  const revision = input.revision ?? (input.supersedes ? input.supersedes.revision + 1 : undefined);
  if (input.supersedes && artifactId !== input.supersedes.artifactId) {
    throw new TypeError("A ManuscriptVersion revision must retain the superseded artifactId.");
  }

  return createResearchArtifact({
    kind: "manuscript_version",
    payload: Object.freeze({
      schemaVersion: 1 as const,
      kind: "manuscript_version" as const,
      title,
      source: Object.freeze({
        format: "latex" as const,
        mainFile: "main.tex" as const,
        content: latex,
        contentHash: hashText(latex),
        singleSourceOfTruth: true as const,
      }),
      target,
      ...(input.template === undefined ? {} : { template: input.template }),
      ...(input.citationSet === undefined ? {} : { citationSetRef: toResearchArtifactRef(input.citationSet) }),
      figureTableRefs: Object.freeze(figureRefs),
      sections: Object.freeze(sections),
      sectionAudits: Object.freeze(sectionAudits),
      ...(input.relatedWork === undefined ? {} : { relatedWork: input.relatedWork }),
      appendix,
      revisionNote: requireText(input.revisionNote, "revisionNote", 8_000),
    }),
    producer: input.producer,
    parents,
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(revision === undefined ? {} : { revision }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export function extractLatexCitationKeys(source: string): string[] {
  const active = stripLatexComments(source);
  const keys: string[] = [];
  const pattern = /\\cite(?:alp|alt|author|p|t|text|year|yearpar)?\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/gu;
  for (const match of active.matchAll(pattern)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const key = raw.trim();
      if (key) keys.push(requireCitationKey(key));
    }
  }
  return uniqueSorted(keys);
}

export function containsActiveLatexCommand(source: string, command: string): boolean {
  const safeCommand = requireIdentifier(command, "LaTeX command").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\\\${safeCommand}\\b`, "u").test(stripLatexComments(source));
}

function normalizeTarget(target: ManuscriptTarget): ManuscriptTarget {
  if (!target || typeof target !== "object" || !["iclr", "generic"].includes(target.venue)) {
    throw new TypeError("Manuscript target venue is invalid.");
  }
  if (!["anonymous_submission", "camera_ready", "internal_draft"].includes(target.mode)) {
    throw new TypeError("Manuscript target mode is invalid.");
  }
  if (target.venue === "iclr" && target.conferenceYear === undefined) {
    throw new TypeError("ICLR manuscripts require a conferenceYear.");
  }
  const conferenceYear = target.conferenceYear === undefined
    ? undefined
    : requirePositiveInteger(target.conferenceYear, "conferenceYear", 9_999);
  const maxMainPages = target.maxMainPages === undefined
    ? target.venue === "iclr" && conferenceYear === 2026 && target.mode === "anonymous_submission" ? 9 : undefined
    : requirePositiveInteger(target.maxMainPages, "maxMainPages", 10_000);
  return Object.freeze({
    venue: target.venue,
    ...(conferenceYear === undefined ? {} : { conferenceYear }),
    mode: target.mode,
    ...(maxMainPages === undefined ? {} : { maxMainPages }),
  });
}

function validateDocument(source: string): void {
  if (!/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/u.test(source)) throw new TypeError("LaTeX source must declare a document class.");
  const begin = source.indexOf("\\begin{document}");
  const end = source.lastIndexOf("\\end{document}");
  if (begin < 0 || end < 0 || end <= begin) throw new TypeError("LaTeX source must contain an ordered document environment.");
}

function bibliographyPosition(source: string): number {
  const bibliography = source.search(/\\bibliography\s*\{/u);
  if (bibliography >= 0) return bibliography;
  return source.search(/\\printbibliography\b/u);
}

