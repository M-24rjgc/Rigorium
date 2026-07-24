export type ResearchDesignCandidateSurveyRecord = Readonly<{
  project: string;
  repository: string;
  license: string;
  maintenanceEvidence: string;
  runEvidence: Readonly<{
    command: string;
    result: "passed" | "not_run";
    observation: string;
  }>;
  decision: "adapt_contract" | "exclude_runtime";
  reusableMechanisms: readonly string[];
  exclusions: readonly string[];
}>;

/**
 * Evidence captured before this module selected a design. It records observed
 * commands, not upstream capability claims, and adds no runtime dependency.
 */
export const RESEARCH_DESIGN_CANDIDATE_SURVEY: readonly ResearchDesignCandidateSurveyRecord[] = Object.freeze([
  {
    project: "OpenScience",
    repository: "https://github.com/synthetic-sciences/openscience",
    license: "Apache-2.0",
    maintenanceEvidence: "Repository was non-archived with a 2026-07-22 main-branch commit when checked on 2026-07-25.",
    runEvidence: {
      command: "openscience --version",
      result: "passed",
      observation: "The published Windows CLI returned 1.3.4.",
    },
    decision: "adapt_contract",
    reusableMechanisms: [
      "artifact and provenance edges",
      "separate planning and review responsibilities",
      "model-agnostic tool boundaries",
    ],
    exclusions: [
      "Bun runtime embedding",
      "browser workspace duplication",
      "unsandboxed shell behavior",
      "Atlas-specific services",
    ],
  },
  {
    project: "PaperQA",
    repository: "https://github.com/Future-House/paper-qa",
    license: "Apache-2.0",
    maintenanceEvidence: "Repository was non-archived with a 2026-07-20 push when checked on 2026-07-25.",
    runEvidence: {
      command: "uvx --from paper-qa pqa --help",
      result: "passed",
      observation: "The CLI loaded and exposed bounded evidence retrieval, source caps, answer attempts, and insufficient-context behavior.",
    },
    decision: "adapt_contract",
    reusableMechanisms: [
      "evidence requests separated from cited evidence",
      "bounded source selection",
      "explicit insufficient-evidence outcomes",
      "repeatable evidence rescans",
    ],
    exclusions: [
      "Python runtime embedding",
      "provider-specific model defaults",
      "index ownership outside the existing literature layer",
    ],
  },
  {
    project: "The AI Scientist",
    repository: "https://github.com/SakanaAI/AI-Scientist",
    license: "The AI Scientist Source Code License (not treated as OSI reusable code)",
    maintenanceEvidence: "Repository was non-archived and its official README was inspected on 2026-07-25.",
    runEvidence: {
      command: "not run",
      result: "not_run",
      observation: "The official workflow requires Linux, CUDA, model credentials, and execution of generated code; a local run would not be a safe or representative probe.",
    },
    decision: "exclude_runtime",
    reusableMechanisms: [
      "similar-work novelty rescan as an input contract",
      "baseline-first comparison",
      "independent review as a distinct artifact",
    ],
    exclusions: [
      "source code reuse under an incompatible license",
      "automatic execution of generated code",
      "GPU- and template-specific orchestration",
      "paper-title generation as a workflow objective",
    ],
  },
]);
