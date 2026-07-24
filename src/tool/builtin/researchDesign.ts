import {
  createResearchDesignPackage,
  type CandidateObjectiveAssessment,
  type CandidatePortfolioBuildInput,
  type ChallengeReportBuildInput,
  type ComparisonObjective,
  type EliminationRecord,
  type ResearchDesignPackage,
  type ResearchDesignPackageInput,
  type ResearchBriefBuildInput,
} from "../../research/design/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationIssue, PilotDeckToolValidationResult } from "../protocol/schema.js";
import type { PilotDeckToolDefinition, PilotDeckToolExecutionOutput } from "../protocol/types.js";

export type ResearchDesignToolInput = Readonly<{
  entry: CandidatePortfolioBuildInput["entry"];
  idea: CandidatePortfolioBuildInput["idea"];
  candidates: CandidatePortfolioBuildInput["candidates"];
  constraints?: CandidatePortfolioBuildInput["constraints"];
  evidenceRequest?: CandidatePortfolioBuildInput["evidenceRequest"];
  citations?: CandidatePortfolioBuildInput["citations"];
  compatibility?: CandidatePortfolioBuildInput["compatibility"];
  independentCriticisms: NonNullable<ChallengeReportBuildInput["independentCriticisms"]>;
  similarWorkRescans: NonNullable<ChallengeReportBuildInput["similarWorkRescans"]>;
  evidenceRescans: NonNullable<ChallengeReportBuildInput["evidenceRescans"]>;
  contradictions?: ChallengeReportBuildInput["contradictions"];
  objectives: readonly ComparisonObjective[];
  assessments: readonly CandidateObjectiveAssessment[];
  eliminations: readonly EliminationRecord[];
  decision: ResearchDesignPackageInput["decision"];
  brief?: Readonly<{ question?: string; title?: ResearchBriefBuildInput["title"] }>;
}>;

export type CreateResearchDesignToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

export function createResearchDesignTool(
  options: CreateResearchDesignToolOptions = {},
): PilotDeckToolDefinition<ResearchDesignToolInput, ResearchDesignPackage> {
  return {
    name: "research_design",
    title: "Develop and Challenge a Research Idea",
    description: `Materialize a research-design decision from a natural-language research discussion.

Use entry=discover when the user provides a broad domain and entry=complete when the user already has an idea. Before calling, develop at least two mechanism-level alternatives rather than title variants, gather EvidencePack citations or an explicit pending evidence request, run a similar-work and evidence rescan, obtain an independent criticism, and score every candidate against multiple objectives. Each candidate must include a theory or algorithm claim, falsification conditions, failure stop rules, baselines, evaluation protocol, compute bounds, and ethics risks and mitigations. The result is an artifact-linked CandidatePortfolio, ChallengeReport, DecisionRecord, and versioned ResearchBrief. This tool does not search the network, run experiments, rename a Project, advance a fixed stage machine, or control AgentLoop. Titles are optional metadata and are never used in ranking; final title confirmation must be explicit in research_brief.`,
    kind: "custom",
    inputSchema: researchDesignInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 2_000_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => validateInput(input),
    execute: async (input, context) => {
      try {
        const normalized = normalizeInput(input);
        const result = createResearchDesignPackage({ ...normalized, now: context.now?.() });
        return formatOutput(result);
      } catch (error) {
        throw invalidInput(error);
      }
    },
  };
}

/** Compatibility export for callers that still describe the primary result by artifact name. */
export const createCandidatePortfolioTool = createResearchDesignTool;

function researchDesignInputSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: [
      "entry",
      "idea",
      "candidates",
      "independentCriticisms",
      "similarWorkRescans",
      "evidenceRescans",
      "objectives",
      "assessments",
      "eliminations",
      "decision",
    ],
    properties: {
      entry: { type: "string", enum: ["discover", "complete"] },
      idea: { type: "object", description: "Broad direction or user-provided idea, with statement and source." },
      candidates: { type: "array", minItems: 2, maxItems: 16, items: { type: "object" } },
      constraints: { type: "array", maxItems: 64, items: { type: "object" } },
      evidenceRequest: { type: "object", description: "Pending or fulfilled EvidencePack request." },
      citations: { type: "array", maxItems: 256, items: { type: "object" } },
      compatibility: { type: "object", description: "Optional dynamic compatibility view of legacy direction artifacts." },
      independentCriticisms: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } },
      similarWorkRescans: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } },
      evidenceRescans: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } },
      contradictions: { type: "array", maxItems: 64, items: { type: "object" } },
      objectives: { type: "array", minItems: 2, maxItems: 16, items: { type: "object" } },
      assessments: { type: "array", minItems: 4, maxItems: 256, items: { type: "object" } },
      eliminations: { type: "array", maxItems: 16, items: { type: "object" } },
      decision: { type: "object" },
      brief: { type: "object" },
    },
  };
}

function normalizeInput(input: unknown): Omit<ResearchDesignPackageInput, "now"> {
  if (!isRecord(input)) throw new TypeError("research_design input must be an object.");
  const value = input as unknown as ResearchDesignToolInput;
  return {
    portfolio: {
      entry: value.entry,
      idea: value.idea,
      candidates: value.candidates,
      constraints: value.constraints,
      evidenceRequest: value.evidenceRequest,
      citations: value.citations,
      compatibility: value.compatibility,
    },
    challenge: {
      independentCriticisms: value.independentCriticisms,
      similarWorkRescans: value.similarWorkRescans,
      evidenceRescans: value.evidenceRescans,
      contradictions: value.contradictions,
    },
    comparison: { objectives: value.objectives, assessments: value.assessments },
    decision: { ...value.decision, eliminations: value.eliminations },
    brief: value.brief,
  };
}

function validateInput(input: unknown): PilotDeckToolValidationResult {
  try {
    createResearchDesignPackage({ ...normalizeInput(input), now: new Date("2000-01-01T00:00:00.000Z") });
    return { ok: true, input };
  } catch (error) {
    const issue: PilotDeckToolValidationIssue = {
      path: "$",
      code: "invalid_schema",
      message: messageOf(error),
    };
    return { ok: false, issues: [issue] };
  }
}

function formatOutput(result: ResearchDesignPackage): PilotDeckToolExecutionOutput<ResearchDesignPackage> {
  const selected = result.decisionRecord.payload.choice ?? "none";
  const lines = [
    "Research design artifacts",
    `Entry: ${result.entry}`,
    `Candidates: ${result.portfolio.payload.candidates.length}`,
    `Pareto frontier: ${result.comparison.paretoFrontierCandidateIds.join(", ") || "none"}`,
    `Decision: ${result.decisionRecord.payload.status}; ${selected}`,
    `Brief: revision ${result.researchBrief.revision}; ${result.researchBrief.payload.status}`,
  ];
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: result },
    ],
    data: result,
    metadata: {
      portfolioArtifactId: result.portfolio.artifactId,
      challengeReportArtifactId: result.challengeReport.artifactId,
      decisionRecordArtifactId: result.decisionRecord.artifactId,
      researchBriefArtifactId: result.researchBrief.artifactId,
      selectedCandidateId: result.decisionRecord.payload.choice,
    },
  };
}

function invalidInput(error: unknown): PilotDeckToolRuntimeError {
  return new PilotDeckToolRuntimeError("invalid_tool_input", `Invalid research design: ${messageOf(error)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
