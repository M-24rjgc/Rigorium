import assert from "node:assert/strict";
import test from "node:test";
import { toResearchArtifactRef } from "../../../src/research/artifacts/index.js";
import { createEvidencePackArtifact } from "../../../src/research/literature/evidencePack.js";
import { createCitationSet } from "../../../src/research/manuscript/citations.js";
import { createManuscriptVersion } from "../../../src/research/manuscript/manuscript.js";
import { auditSectionGeneration } from "../../../src/research/manuscript/sections.js";
import { SYNTHETIC_NOW } from "./fixtures.js";

test("section generation blocks result prose until an observed artifact is linked", () => {
  const audit = auditSectionGeneration({
    sectionId: "results",
    kind: "results",
    title: "Synthetic Results",
    requestedOutput: "draft",
    minimumMaturity: "observed_result",
    statements: [{
      statementId: "synthetic-result",
      kind: "result",
      maturity: "citation_only",
      citationKeys: ["synthetic2026"],
      evidenceRefs: [],
      figureTableRefs: [],
      textOrigin: "agent_assisted",
    }],
  });
  assert.equal(audit.status, "blocked");
  assert.equal(audit.allowedOutput, "outline_only");
  assert.equal(audit.blockers.some((blocker) => blocker.code === "missing_observed_result"), true);
});

test("ManuscriptVersion keeps one canonical LaTeX source and versioned artifact links", () => {
  const evidence = createEvidencePackArtifact({
    artifactId: "synthetic-evidence",
    entries: [{
      id: "synthetic-entry",
      paperId: "paper-synthetic",
      locator: { sourceId: "synthetic", recordId: "record-1", page: 1, paragraph: 1 },
      snapshot: { content: "Synthetic evidence fixture, not a research claim." },
    }],
    producer: { kind: "import" },
    now: SYNTHETIC_NOW,
  });
  const citations = createCitationSet({
    bibtexEntries: [{
      citationKey: "synthetic2026",
      entryType: "article",
      paperId: "paper-synthetic",
      fields: { title: "Synthetic source", author: "Synthetic Author", year: "2026" },
    }],
    producer: { kind: "import" },
    now: SYNTHETIC_NOW,
  });
  const latex = `\\documentclass{article}
\\begin{document}
Synthetic related-work fixture \\citep{synthetic2026}.
\\label{rigorium-main-matter-end}
\\bibliographystyle{plain}
\\bibliography{references}
\\label{rigorium-bibliography-end}
\\appendix
\\label{rigorium-appendix-start}
Synthetic appendix fixture.
\\end{document}`;
  const first = createManuscriptVersion({
    title: "Synthetic Manuscript Fixture",
    latex,
    target: { venue: "generic", mode: "internal_draft" },
    sections: [{
      sectionId: "related-work",
      kind: "related_work",
      title: "Related Work",
      requestedOutput: "draft",
      minimumMaturity: "evidence_snapshot",
      statements: [{
        statementId: "prior-synthetic",
        kind: "prior_work",
        maturity: "evidence_snapshot",
        citationKeys: ["synthetic2026"],
        evidenceRefs: [toResearchArtifactRef(evidence)],
        figureTableRefs: [],
        textOrigin: "user",
      }],
    }],
    revisionNote: "Initial synthetic fixture.",
    producer: { kind: "user" },
    citationSet: citations,
    evidencePacks: [evidence],
    artifactId: "synthetic-manuscript",
    now: SYNTHETIC_NOW,
  });
  const second = createManuscriptVersion({
    title: "Synthetic Manuscript Fixture",
    latex: latex.replace("Synthetic appendix fixture.", "Revised synthetic appendix fixture."),
    target: { venue: "generic", mode: "internal_draft" },
    sections: first.payload.sections,
    revisionNote: "Revised synthetic appendix fixture.",
    producer: { kind: "user" },
    citationSet: citations,
    evidencePacks: [evidence],
    supersedes: first,
    now: SYNTHETIC_NOW,
  });

  assert.equal(first.payload.source.singleSourceOfTruth, true);
  assert.equal(first.payload.appendix.afterBibliography, true);
  assert.equal(first.payload.sectionAudits[0]?.status, "ready");
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.revision, 2);
  assert.equal(second.parents.some((parent) => parent.relation === "supersedes"), true);
});

