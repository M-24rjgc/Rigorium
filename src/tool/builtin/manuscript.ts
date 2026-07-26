import { resolve } from "node:path";
import type { PermissionResult } from "../../permission/index.js";
import {
  createCitationSet,
  createFigureTableArtifact,
  createManuscriptVersion,
  organizeRelatedWork,
  probeIclrTemplate,
  renderManuscript,
  resolveWithin,
  validateSectionCollection,
  auditSectionGeneration,
  verifyFigureTableArtifactFiles,
  type BibtexEntryData,
  type CitationSetArtifact,
  type FigureTableArtifact,
  type FigureTableFileVerification,
  type FigureTableItemInput,
  type LiteratureMapForManuscript,
  type ManuscriptExportRequest,
  type ManuscriptTemplatePin,
  type ManuscriptTarget,
  type ManuscriptVersionArtifact,
  type RelatedWorkMapGroup,
  type RelatedWorkPlan,
  type RenderManuscriptOptions,
  type RenderRunArtifact,
  type SectionGenerationAudit,
  type SectionGenerationContract,
  type TemplateProbe,
  type ZoteroCitationData,
} from "../../research/manuscript/index.js";
import type { EvidencePackArtifact } from "../../research/literature/evidencePack.js";
import { RigoriumToolRuntimeError } from "../protocol/errors.js";
import type { RigoriumToolValidationIssue, RigoriumToolValidationResult } from "../protocol/schema.js";
import type {
  RigoriumToolDefinition,
  RigoriumToolExecutionOutput,
  RigoriumToolRuntimeContext,
} from "../protocol/types.js";

const TOOL_NAME = "manuscript_latex";
const ACTIONS = [
  "citation_set",
  "section_audit",
  "related_work",
  "figure_table",
  "manuscript_version",
  "template_probe",
  "render",
] as const;

type ManuscriptAction = typeof ACTIONS[number];

export type ManuscriptCitationSetInput = Readonly<{
  action: "citation_set";
  zoteroItems?: readonly ZoteroCitationData[];
  bibtexEntries?: readonly BibtexEntryData[];
  artifactId?: string;
}>;

export type ManuscriptSectionAuditInput = Readonly<{
  action: "section_audit";
  sections: readonly SectionGenerationContract[];
}>;

export type ManuscriptRelatedWorkInput = Readonly<{
  action: "related_work";
  map: LiteratureMapForManuscript;
  citationSet: CitationSetArtifact;
  evidencePacks: readonly EvidencePackArtifact[];
  groups?: readonly RelatedWorkMapGroup[];
}>;

export type ManuscriptFigureTableInput = Readonly<{
  action: "figure_table";
  items: readonly FigureTableItemInput[];
  artifactId?: string;
}>;

export type ManuscriptVersionInput = Readonly<{
  action: "manuscript_version";
  title: string;
  latex: string;
  target: ManuscriptTarget;
  sections: readonly SectionGenerationContract[];
  revisionNote: string;
  citationSet?: CitationSetArtifact;
  figureTables?: readonly FigureTableArtifact[];
  evidencePacks?: readonly EvidencePackArtifact[];
  relatedWork?: RelatedWorkPlan;
  template?: ManuscriptTemplatePin;
  supersedes?: ManuscriptVersionArtifact;
  artifactId?: string;
  revision?: number;
}>;

export type ManuscriptTemplateProbeInput = Readonly<{
  action: "template_probe";
  conferenceYear: number;
  archivePath?: string;
  directoryPath?: string;
}>;

export type ManuscriptRenderInput = Readonly<{
  action: "render";
  manuscript: ManuscriptVersionArtifact;
  citationSet?: CitationSetArtifact;
  figureTables?: readonly FigureTableArtifact[];
  templateDirectory?: string;
  templateArchive?: string;
  engine?: "auto" | "latexmk" | "tectonic" | "pdflatex" | "xelatex" | "lualatex";
  timeoutMs?: number;
  export?: ManuscriptExportRequest;
  artifactId?: string;
}>;

export type ManuscriptToolInput =
  | ManuscriptCitationSetInput
  | ManuscriptSectionAuditInput
  | ManuscriptRelatedWorkInput
  | ManuscriptFigureTableInput
  | ManuscriptVersionInput
  | ManuscriptTemplateProbeInput
  | ManuscriptRenderInput;

export type ManuscriptToolResult =
  | Readonly<{ schemaVersion: 1; kind: "manuscript_tool_result"; action: "citation_set"; artifact: CitationSetArtifact }>
  | Readonly<{ schemaVersion: 1; kind: "manuscript_tool_result"; action: "section_audit"; audits: readonly SectionGenerationAudit[] }>
  | Readonly<{ schemaVersion: 1; kind: "manuscript_tool_result"; action: "related_work"; plan: RelatedWorkPlan }>
  | Readonly<{
      schemaVersion: 1;
      kind: "manuscript_tool_result";
      action: "figure_table";
      artifact: FigureTableArtifact;
      verification: FigureTableFileVerification;
    }>
  | Readonly<{ schemaVersion: 1; kind: "manuscript_tool_result"; action: "manuscript_version"; artifact: ManuscriptVersionArtifact }>
  | Readonly<{ schemaVersion: 1; kind: "manuscript_tool_result"; action: "template_probe"; probe: TemplateProbe }>
  | Readonly<{ schemaVersion: 1; kind: "manuscript_tool_result"; action: "render"; artifact: RenderRunArtifact }>;

export type CreateManuscriptToolOptions = Readonly<{
  render?: RenderManuscriptOptions;
  maxResultBytes?: number;
}>;

export function createManuscriptTool(
  options: CreateManuscriptToolOptions = {},
): RigoriumToolDefinition<ManuscriptToolInput, ManuscriptToolResult> {
  return {
    name: TOOL_NAME,
    title: "Build and Render Evidence-Aware LaTeX Manuscripts",
    description: `Create citation sets from structured Zotero or BibTeX entry data, audit evidence maturity before drafting sections, organize Related Work from reviewed literature maps and EvidencePacks, preserve figure/table provenance, version a canonical LaTeX source, inspect pinned venue templates, or render with deterministic diagnostics.

Use whichever action matches the current natural-language request; there is no required stage sequence. This tool does not generate scientific claims or results. A result section remains outline-only until observed evidence is linked. ICLR rendering accepts only a verified pin, currently ICLR 2026; it does not assume an ICLR 2027 template exists. Rendering uses a temporary workspace, and files cross into the current Project only through an explicit confirmed export request.`,
    kind: "custom",
    inputSchema: inputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 4_000_000,
    isReadOnly: (input) => input?.action !== "render",
    isConcurrencySafe: (input) => input?.action !== "render",
    isDestructive: (input) => input?.action === "render" && input.export?.confirmed === true && input.export.overwrite === true,
    requiresUserInteraction: (input) => input?.action === "render" && input.export !== undefined,
    isOpenWorld: () => false,
    validateInput: async (input): Promise<RigoriumToolValidationResult> => validateInput(input),
    checkPermissions: async (): Promise<PermissionResult> => ({ type: "passthrough" }),
    execute: async (rawInput, context) => {
      let input: ManuscriptToolInput;
      try {
        input = normalizeInput(rawInput);
      } catch (error) {
        throw invalidInput(error);
      }
      try {
        const result = await executeAction(input, context, options);
        return formatOutput(result);
      } catch (error) {
        if (error instanceof RigoriumToolRuntimeError) throw error;
        if (error instanceof TypeError) throw invalidInput(error);
        throw new RigoriumToolRuntimeError("tool_execution_failed", errorMessage(error));
      }
    },
  };
}

async function executeAction(
  input: ManuscriptToolInput,
  context: RigoriumToolRuntimeContext,
  options: CreateManuscriptToolOptions,
): Promise<ManuscriptToolResult> {
  const now = context.now?.() ?? new Date();
  const producer = { kind: "tool" as const, toolName: TOOL_NAME };
  if (input.action === "citation_set") {
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "manuscript_tool_result" as const,
      action: input.action,
      artifact: createCitationSet({
        ...(input.zoteroItems === undefined ? {} : { zoteroItems: input.zoteroItems }),
        ...(input.bibtexEntries === undefined ? {} : { bibtexEntries: input.bibtexEntries }),
        ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
        producer,
        now,
      }),
    });
  }
  if (input.action === "section_audit") {
    const sections = validateSectionCollection(input.sections);
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "manuscript_tool_result" as const,
      action: input.action,
      audits: Object.freeze(sections.map(auditSectionGeneration)),
    });
  }
  if (input.action === "related_work") {
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "manuscript_tool_result" as const,
      action: input.action,
      plan: organizeRelatedWork(input),
    });
  }
  if (input.action === "figure_table") {
    const artifact = createFigureTableArtifact({
      items: input.items,
      producer,
      ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
      now,
    });
    const verification = await verifyFigureTableArtifactFiles({ projectRoot: context.cwd, artifact });
    if (verification.status !== "verified") {
      throw new RigoriumToolRuntimeError(
        "invalid_tool_input",
        `Figure/table provenance verification failed: ${verification.files.filter((file) => file.status !== "verified").map((file) => `${file.path}:${file.status}`).join(", ")}.`,
      );
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "manuscript_tool_result" as const,
      action: input.action,
      artifact,
      verification,
    });
  }
  if (input.action === "manuscript_version") {
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "manuscript_tool_result" as const,
      action: input.action,
      artifact: createManuscriptVersion({
        ...input,
        producer,
        now,
      }),
    });
  }
  if (input.action === "template_probe") {
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "manuscript_tool_result" as const,
      action: input.action,
      probe: await probeIclrTemplate({
        conferenceYear: input.conferenceYear,
        ...(input.archivePath === undefined ? {} : { archivePath: resolveProjectPath(context.cwd, input.archivePath) }),
        ...(input.directoryPath === undefined ? {} : { directoryPath: resolveProjectPath(context.cwd, input.directoryPath) }),
      }),
    });
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "manuscript_tool_result" as const,
    action: input.action,
    artifact: await renderManuscript({
      projectRoot: context.cwd,
      manuscript: input.manuscript,
      ...(input.citationSet === undefined ? {} : { citationSet: input.citationSet }),
      ...(input.figureTables === undefined ? {} : { figureTables: input.figureTables }),
      ...(input.templateDirectory === undefined ? {} : { templateDirectory: resolveProjectPath(context.cwd, input.templateDirectory) }),
      ...(input.templateArchive === undefined ? {} : { templateArchive: resolveProjectPath(context.cwd, input.templateArchive) }),
      ...(input.engine === undefined ? {} : { engine: input.engine }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.export === undefined ? {} : { export: input.export }),
      ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
      ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
      producer,
      now,
    }, options.render),
  });
}

function normalizeInput(value: unknown): ManuscriptToolInput {
  if (!isRecord(value)) throw new TypeError("manuscript_latex requires an input object.");
  if (typeof value.action !== "string" || !(ACTIONS as readonly string[]).includes(value.action)) {
    throw new TypeError(`action must be one of: ${ACTIONS.join(", ")}.`);
  }
  const action = value.action as ManuscriptAction;
  assertAllowedKeys(value, allowedKeys(action));
  if (action === "citation_set") {
    return {
      action,
      ...(value.zoteroItems === undefined ? {} : { zoteroItems: value.zoteroItems as readonly ZoteroCitationData[] }),
      ...(value.bibtexEntries === undefined ? {} : { bibtexEntries: value.bibtexEntries as readonly BibtexEntryData[] }),
      ...(value.artifactId === undefined ? {} : { artifactId: value.artifactId as string }),
    };
  }
  if (action === "section_audit") return { action, sections: value.sections as readonly SectionGenerationContract[] };
  if (action === "related_work") {
    return {
      action,
      map: value.map as LiteratureMapForManuscript,
      citationSet: value.citationSet as CitationSetArtifact,
      evidencePacks: value.evidencePacks as readonly EvidencePackArtifact[],
      ...(value.groups === undefined ? {} : { groups: value.groups as readonly RelatedWorkMapGroup[] }),
    };
  }
  if (action === "figure_table") {
    return {
      action,
      items: value.items as readonly FigureTableItemInput[],
      ...(value.artifactId === undefined ? {} : { artifactId: value.artifactId as string }),
    };
  }
  if (action === "manuscript_version") {
    return value as unknown as ManuscriptVersionInput;
  }
  if (action === "template_probe") {
    return {
      action,
      conferenceYear: value.conferenceYear as number,
      ...(value.archivePath === undefined ? {} : { archivePath: value.archivePath as string }),
      ...(value.directoryPath === undefined ? {} : { directoryPath: value.directoryPath as string }),
    };
  }
  return value as unknown as ManuscriptRenderInput;
}

function validateInput(input: unknown): RigoriumToolValidationResult {
  try {
    const normalized = normalizeInput(input);
    if (normalized.action === "citation_set") {
      createCitationSet({
        ...(normalized.zoteroItems === undefined ? {} : { zoteroItems: normalized.zoteroItems }),
        ...(normalized.bibtexEntries === undefined ? {} : { bibtexEntries: normalized.bibtexEntries }),
        producer: { kind: "tool", toolName: TOOL_NAME },
      });
    } else if (normalized.action === "section_audit") {
      validateSectionCollection(normalized.sections);
    } else if (normalized.action === "figure_table") {
      createFigureTableArtifact({ items: normalized.items, producer: { kind: "tool", toolName: TOOL_NAME } });
    } else if (normalized.action === "manuscript_version") {
      createManuscriptVersion({ ...normalized, producer: { kind: "tool", toolName: TOOL_NAME } });
    } else if (normalized.action === "template_probe") {
      if (!Number.isSafeInteger(normalized.conferenceYear) || normalized.conferenceYear < 1) throw new TypeError("conferenceYear must be a positive integer.");
    } else if (normalized.action === "related_work") {
      if (!normalized.map || !normalized.citationSet || !Array.isArray(normalized.evidencePacks)) throw new TypeError("related_work requires map, citationSet, and evidencePacks.");
    } else if (!normalized.manuscript) {
      throw new TypeError("render requires a ManuscriptVersion artifact.");
    }
    return { ok: true, input };
  } catch (error) {
    const issue: RigoriumToolValidationIssue = { path: "$", code: "invalid_schema", message: errorMessage(error) };
    return { ok: false, issues: [issue] };
  }
}

function inputSchema(): RigoriumToolDefinition["inputSchema"] {
  const object = { type: "object", additionalProperties: true } as const;
  return {
    type: "object",
    required: ["action"],
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      zoteroItems: { type: "array", maxItems: 5_000, items: object },
      bibtexEntries: { type: "array", maxItems: 5_000, items: object },
      artifactId: { type: "string", maxLength: 256 },
      sections: { type: "array", maxItems: 128, items: object },
      map: object,
      citationSet: object,
      evidencePacks: { type: "array", maxItems: 256, items: object },
      groups: { type: "array", maxItems: 512, items: object },
      items: { type: "array", maxItems: 512, items: object },
      title: { type: "string", maxLength: 2_000 },
      latex: { type: "string", maxLength: 4_000_000 },
      target: object,
      revisionNote: { type: "string", maxLength: 8_000 },
      figureTables: { type: "array", maxItems: 512, items: object },
      relatedWork: object,
      template: object,
      supersedes: object,
      revision: { type: "integer", minimum: 1 },
      conferenceYear: { type: "integer", minimum: 1, maximum: 9_999 },
      archivePath: { type: "string", maxLength: 4_096 },
      directoryPath: { type: "string", maxLength: 4_096 },
      manuscript: object,
      templateDirectory: { type: "string", maxLength: 4_096 },
      templateArchive: { type: "string", maxLength: 4_096 },
      engine: { type: "string", enum: ["auto", "latexmk", "tectonic", "pdflatex", "xelatex", "lualatex"] },
      timeoutMs: { type: "integer", minimum: 1, maximum: 900_000 },
      export: object,
    },
  };
}

function allowedKeys(action: ManuscriptAction): readonly string[] {
  const common = ["action"];
  if (action === "citation_set") return [...common, "zoteroItems", "bibtexEntries", "artifactId"];
  if (action === "section_audit") return [...common, "sections"];
  if (action === "related_work") return [...common, "map", "citationSet", "evidencePacks", "groups"];
  if (action === "figure_table") return [...common, "items", "artifactId"];
  if (action === "manuscript_version") {
    return [...common, "title", "latex", "target", "sections", "revisionNote", "citationSet", "figureTables", "evidencePacks", "relatedWork", "template", "supersedes", "artifactId", "revision"];
  }
  if (action === "template_probe") return [...common, "conferenceYear", "archivePath", "directoryPath"];
  return [...common, "manuscript", "citationSet", "figureTables", "templateDirectory", "templateArchive", "engine", "timeoutMs", "export", "artifactId"];
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !set.has(key));
  if (unknown) throw new TypeError(`${value.action}.${unknown} is not supported.`);
}

function resolveProjectPath(projectRoot: string, value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Project path must be non-empty text.");
  if (value.includes("\u0000")) throw new TypeError("Project path must not contain NUL characters.");
  return resolveWithin(projectRoot, resolve(projectRoot, value), "Project path");
}

function formatOutput(result: ManuscriptToolResult): RigoriumToolExecutionOutput<ManuscriptToolResult> {
  const lines = [`Manuscript/LaTeX: ${result.action}`];
  if (result.action === "citation_set") lines.push(`Citations: ${result.artifact.payload.entries.length}`, `Artifact: ${result.artifact.artifactId}`);
  else if (result.action === "section_audit") lines.push(`Sections: ${result.audits.length}`, `Blocked: ${result.audits.filter((audit) => audit.status === "blocked").length}`);
  else if (result.action === "related_work") lines.push(`Groups: ${result.plan.groups.length}`, `Uncited papers: ${result.plan.uncitedPaperIds.length}`);
  else if (result.action === "figure_table") lines.push(`Items: ${result.artifact.payload.items.length}`, "File provenance: verified");
  else if (result.action === "manuscript_version") lines.push(`Artifact: ${result.artifact.artifactId}@${result.artifact.revision}`, "Canonical source: main.tex");
  else if (result.action === "template_probe") lines.push(`ICLR ${result.probe.conferenceYear}: ${result.probe.status}`);
  else lines.push(`Compile: ${result.artifact.payload.compileStatus}`, `Export performed: ${result.artifact.payload.exportBoundary.performed ? "yes" : "no"}`);
  return {
    content: [{ type: "text", text: lines.join("\n") }, { type: "json", value: result }],
    data: result,
    metadata: { action: result.action },
  };
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function invalidInput(error: unknown): RigoriumToolRuntimeError {
  return error instanceof RigoriumToolRuntimeError
    ? error
    : new RigoriumToolRuntimeError("invalid_tool_input", errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
