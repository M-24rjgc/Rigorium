import { VenueCorpus, type CorpusPaper } from "../../research/manuscript/style/VenueCorpus.js";
import { StyleProfileStore } from "../../research/manuscript/style/StyleProfileStore.js";
import type { StyleProfile } from "../../research/manuscript/style/index.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult, RigoriumToolInputSchema } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

/**
 * venue_corpus — the agent's corpus + style-profile surface.
 *
 * The agent collects ~10 high-quality papers from the target venue (best
 * papers + top-scored), records them here, then studies them at fine
 * granularity and saves the resulting style profile. The tool stores and
 * validates; the *learning* is the agent's job — no fixed analysis pipeline.
 */

export type VenueCorpusToolInput =
  | Readonly<{ action: "papers_list"; venue?: string }>
  | Readonly<{ action: "paper_add"; paper: Omit<CorpusPaper, "addedAt"> }>
  | Readonly<{ action: "paper_remove"; paperId: string }>
  | Readonly<{ action: "style_get"; venue: string }>
  | Readonly<{ action: "style_save"; profile: StyleProfile }>
  | Readonly<{ action: "style_list" }>;

export type VenueCorpusToolResult =
  | Readonly<{ action: "papers_list"; venue?: string; papers: readonly CorpusPaper[] }>
  | Readonly<{
      action: "paper_add";
      paper: CorpusPaper;
      corpusSize: number;
      /** Papers evicted by the per-venue cap (oldest-first, same venue). */
      evicted: readonly CorpusPaper[];
    }>
  | Readonly<{ action: "paper_remove"; removed: boolean }>
  | Readonly<{ action: "style_get"; venue: string; profile?: StyleProfile }>
  | Readonly<{
      action: "style_save";
      venue: string;
      superseded: boolean;
      learnedFromCount: number;
    }>
  | Readonly<{ action: "style_list"; profiles: readonly StyleProfile[] }>;

export type CreateVenueCorpusToolOptions = Readonly<{
  maxResultBytes?: number;
  corpusFactory?: (projectRoot: string) => VenueCorpus;
  styleStoreFactory?: (projectRoot: string) => StyleProfileStore;
}>;

export function createVenueCorpusTool(
  options: CreateVenueCorpusToolOptions = {},
): RigoriumToolDefinition<VenueCorpusToolInput, VenueCorpusToolResult> {
  return {
    name: "venue_corpus",
    title: "Manage Venue Paper Corpus and Style Profiles",
    description: `Manage the per-venue paper corpus (~10 high-scoring papers for style learning) and the fine-grained style profile learned from it.

Use action=paper_add to record a paper you collected from the target venue (best papers, top review scores, surveys) with its local PDF/TeX paths. Use action=papers_list to see the corpus. Use action=style_save to persist a StyleProfile you learned by studying the corpus at fine granularity — sentence templates, paragraph patterns, figure conventions, LaTeX conventions, story arc — one profile per venue, saved profiles supersede earlier ones for the same venue. The tool stores and validates; you decide what to collect, how deeply to study it, and what the profile contains.`,
    kind: "custom",
    inputSchema: venueCorpusInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 2_000_000,
    isReadOnly: (input) => input.action === "papers_list" || input.action === "style_get" || input.action === "style_list",
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    validateInput: async (input) => validateInput(input),
    execute: async (input, context) => {
      try {
        return formatOutput(await executeAction(input, context, options));
      } catch (error) {
        throw new RigoriumToolRuntimeError("invalid_tool_input", `Invalid venue corpus action: ${messageOf(error)}`);
      }
    },
  };
}

async function executeAction(
  input: VenueCorpusToolInput,
  context: RigoriumToolRuntimeContext,
  options: CreateVenueCorpusToolOptions,
): Promise<VenueCorpusToolResult> {
  requireActionInput(input);
  const projectRoot = context.cwd;
  const corpus = options.corpusFactory
    ? options.corpusFactory(projectRoot)
    : new VenueCorpus({ projectRoot });
  const styleStore = options.styleStoreFactory
    ? options.styleStoreFactory(projectRoot)
    : new StyleProfileStore({ projectRoot });

  switch (input.action) {
    case "papers_list": {
      const papers = await corpus.listPapers();
      const filtered = input.venue ? papers.filter((paper) => paper.venue === input.venue) : papers;
      return Object.freeze({ action: "papers_list", venue: input.venue, papers: Object.freeze(filtered) });
    }
    case "paper_add": {
      const result = await corpus.addPaper(input.paper);
      return Object.freeze({
        action: "paper_add",
        paper: result.paper,
        corpusSize: await corpus.size(),
        evicted: result.evicted,
      });
    }
    case "paper_remove": {
      const removed = await corpus.removePaper(input.paperId);
      return Object.freeze({ action: "paper_remove", removed });
    }
    case "style_get": {
      const profile = await styleStore.get(input.venue);
      return Object.freeze({ action: "style_get", venue: input.venue, ...(profile ? { profile } : {}) });
    }
    case "style_save": {
      const result = await styleStore.save(input.profile);
      return Object.freeze({
        action: "style_save",
        venue: result.saved.venue,
        superseded: result.superseded,
        learnedFromCount: result.saved.learnedFrom.length,
      });
    }
    case "style_list": {
      const profiles = await styleStore.list();
      return Object.freeze({ action: "style_list", profiles: Object.freeze(profiles) });
    }
  }
}

function requireActionInput(input: unknown): asserts input is VenueCorpusToolInput {
  if (!input || typeof input !== "object" || typeof (input as { action?: unknown }).action !== "string") {
    throw new RigoriumToolRuntimeError(
      "invalid_tool_input",
      "venue_corpus requires an action: papers_list, paper_add, paper_remove, style_get, style_save, or style_list.",
    );
  }
}

async function validateInput(input: VenueCorpusToolInput): Promise<RigoriumToolValidationResult> {
  try {
    requireActionInput(input);
    if (input.action === "paper_add") {
      if (!input.paper || typeof input.paper.paperId !== "string" || typeof input.paper.title !== "string") {
        return { ok: false, issues: [issue("paper_add requires paper.paperId and paper.title")] };
      }
    }
    if (input.action === "style_save" && !input.profile) {
      return { ok: false, issues: [issue("style_save requires a profile")] };
    }
    return { ok: true, input };
  } catch {
    return { ok: false, issues: [issue("invalid venue_corpus input")] };
  }
}

function issue(message: string): RigoriumToolValidationIssue {
  return { path: "", code: "invalid_type", message };
}

function venueCorpusInputSchema(): RigoriumToolInputSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["papers_list", "paper_add", "paper_remove", "style_get", "style_save", "style_list"],
      },
      venue: { type: "string" },
      paperId: { type: "string" },
      paper: { type: "object" },
      profile: { type: "object" },
    },
  };
}

function formatOutput(result: VenueCorpusToolResult): RigoriumToolExecutionOutput<VenueCorpusToolResult> {
  return { content: [{ type: "text", text: renderSummary(result) }], data: result };
}

function renderSummary(result: VenueCorpusToolResult): string {
  switch (result.action) {
    case "papers_list":
      if (result.papers.length === 0) {
        return "Corpus is empty. Collect ~10 high-scoring papers from the target venue (best papers + top review scores) and record them with paper_add.";
      }
      return `Corpus (${result.papers.length} papers):\n` + result.papers
        .map((paper) => `${paper.paperId} [${paper.year}, ${paper.selection}, ${paper.source}] ${paper.title}${paper.pdfPath ? ` — ${paper.pdfPath}` : ""}`)
        .join("\n");
    case "paper_add":
      return `Recorded ${result.paper.paperId} (corpus size ${result.corpusSize})${result.evicted.length > 0 ? `; evicted oldest same-venue papers: ${result.evicted.map((paper) => paper.paperId).join(", ")}` : ""}.`;
    case "paper_remove":
      return result.removed ? "Paper removed." : "Paper not found.";
    case "style_get":
      return result.profile
        ? `Style profile for ${result.venue} (learned from ${result.profile.learnedFrom.length} papers, ${new Date(result.profile.computedAt).toISOString()}):\n` +
          `- Story arc: ${result.profile.storyArc.length} beats\n` +
          `- Sentence templates: ${result.profile.sentenceTemplates.length}\n` +
          `- Paragraph patterns: ${result.profile.paragraphPatterns.length}\n` +
          `- Figure conventions: ${result.profile.figureConventions.length}\n` +
          `- LaTeX conventions: ${result.profile.latexConventions?.packages?.length ?? 0} packages` +
          (result.profile.writingVoice ? `\n- Voice: ${result.profile.writingVoice}` : "")
        : `No style profile for ${result.venue} yet. Study the corpus and save one with style_save.`;
    case "style_save":
      return `Saved style profile for ${result.venue} (learned from ${result.learnedFromCount} papers)${result.superseded ? "; superseded an earlier profile" : ""}.`;
    case "style_list":
      return result.profiles.length === 0
        ? "No style profiles saved yet."
        : `Style profiles: ${result.profiles.map((profile) => `${profile.venue} (${profile.learnedFrom.length} papers)`).join(", ")}`;
  }
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
