import type {
  ResearchArtifactEnvelope,
  ResearchArtifactProducer,
  ResearchArtifactRef,
} from "../artifacts/index.js";
import type { EvidencePackArtifact } from "../literature/evidencePack.js";
import type { LiveLiteratureMap, FrozenLiteratureMapSnapshot } from "../literature/mapMaintenance.js";
import type { ZoteroLibraryItem } from "../types.js";

export const MANUSCRIPT_SCHEMA_VERSION = 1 as const;

export const MANUSCRIPT_PAGE_MARKERS = Object.freeze({
  mainMatterEnd: "rigorium-main-matter-end",
  bibliographyEnd: "rigorium-bibliography-end",
  appendixStart: "rigorium-appendix-start",
});

export type BibtexEntryData = Readonly<{
  citationKey: string;
  entryType: string;
  fields: Readonly<Record<string, string>>;
  paperId?: string;
  sourceRecordId?: string;
}>;

export type ZoteroCitationData = Readonly<{
  item: ZoteroLibraryItem;
  citationKey?: string;
  paperId?: string;
  /** Optional hash of the official Zotero export or source record. */
  sourceContentHash?: string;
}>;

export type CitationRecord = Readonly<{
  citationKey: string;
  entryType: string;
  title: string;
  authors: readonly string[];
  fields: Readonly<Record<string, string>>;
  bibtex: string;
  source: Readonly<{
    kind: "zotero" | "bibtex";
    recordId: string;
    contentHash: string;
  }>;
  paperId?: string;
}>;

export type CitationSetDiagnostic = Readonly<{
  code: "generated_key" | "key_collision_resolved" | "missing_author" | "missing_year";
  citationKey: string;
  message: string;
}>;

export type CitationSetPayload = Readonly<{
  schemaVersion: 1;
  kind: "citation_set";
  entries: readonly CitationRecord[];
  citationKeys: readonly string[];
  bibtex: string;
  diagnostics: readonly CitationSetDiagnostic[];
}>;

export type CitationSetArtifact = ResearchArtifactEnvelope<"citation_set", CitationSetPayload>;

export type EvidenceMaturity =
  | "none"
  | "citation_only"
  | "evidence_snapshot"
  | "observed_result"
  | "replicated_result";

export type ManuscriptStatementKind =
  | "context"
  | "prior_work"
  | "method"
  | "result"
  | "interpretation"
  | "limitation";

export type ManuscriptStatementBinding = Readonly<{
  statementId: string;
  kind: ManuscriptStatementKind;
  maturity: EvidenceMaturity;
  citationKeys: readonly string[];
  evidenceRefs: readonly ResearchArtifactRef[];
  figureTableRefs: readonly ResearchArtifactRef[];
  textOrigin: "user" | "import" | "agent_assisted";
}>;

export type ManuscriptSectionKind =
  | "abstract"
  | "introduction"
  | "related_work"
  | "method"
  | "experiments"
  | "results"
  | "discussion"
  | "conclusion"
  | "ethics"
  | "reproducibility"
  | "appendix"
  | "custom";

export type SectionGenerationContract = Readonly<{
  sectionId: string;
  kind: ManuscriptSectionKind;
  title: string;
  requestedOutput: "outline" | "draft" | "preserve";
  minimumMaturity: EvidenceMaturity;
  statements: readonly ManuscriptStatementBinding[];
  /** User-authored scope, not prose for a model to present as a result. */
  scopeNote?: string;
}>;

export type SectionGenerationAudit = Readonly<{
  sectionId: string;
  status: "ready" | "blocked";
  allowedOutput: "outline_only" | "draft_allowed" | "preserve_only";
  strongestMaturity: EvidenceMaturity;
  blockers: readonly Readonly<{
    code: "insufficient_maturity" | "missing_citation" | "missing_evidence" | "missing_observed_result";
    statementId?: string;
    message: string;
  }>[];
}>;

export type LiteratureMapForManuscript = LiveLiteratureMap | FrozenLiteratureMapSnapshot;

export type RelatedWorkMapGroup = Readonly<{
  groupId: string;
  label: string;
  paperIds: readonly string[];
  comparisonAxes?: readonly string[];
}>;

export type RelatedWorkEvidenceRef = Readonly<{
  evidencePack: ResearchArtifactRef;
  entryId: string;
  paperId: string;
  locatorLabel: string;
}>;

export type RelatedWorkGroupPlan = Readonly<{
  groupId: string;
  label: string;
  paperIds: readonly string[];
  citationKeys: readonly string[];
  evidence: readonly RelatedWorkEvidenceRef[];
  comparisonAxes: readonly string[];
  coverage: Readonly<{
    mappedPaperCount: number;
    citedPaperCount: number;
    evidencedPaperCount: number;
    status: "complete" | "partial" | "unsupported";
  }>;
}>;

export type RelatedWorkPlan = Readonly<{
  schemaVersion: 1;
  kind: "related_work_plan";
  sourceMapId: string;
  sourceMapRevision: number;
  groups: readonly RelatedWorkGroupPlan[];
  ungroupedPaperIds: readonly string[];
  uncitedPaperIds: readonly string[];
  evidencePackRefs: readonly ResearchArtifactRef[];
}>;

export type FigureTableFileRef = Readonly<{
  path: string;
  contentHash: string;
  mediaType: string;
}>;

export type FigureTableScriptProvenance =
  | Readonly<{
      status: "available";
      file: FigureTableFileRef;
      command: readonly string[];
    }>
  | Readonly<{
      status: "not_applicable";
      reason: string;
    }>;

export type FigureTableItemInput = Readonly<{
  itemId: string;
  kind: "figure" | "table";
  label: string;
  data: readonly FigureTableFileRef[];
  script: FigureTableScriptProvenance;
  output: FigureTableFileRef;
  captionLatex: string;
  captionEvidenceRefs: readonly ResearchArtifactRef[];
  citationKeys: readonly string[];
}>;

export type FigureTableItem = FigureTableItemInput & Readonly<{
  captionContentHash: string;
  reuseStatus: "recomputable" | "output_only";
}>;

export type FigureTablePayload = Readonly<{
  schemaVersion: 1;
  kind: "figure_table";
  items: readonly FigureTableItem[];
}>;

export type FigureTableArtifact = ResearchArtifactEnvelope<"figure_table", FigureTablePayload>;

export type ManuscriptTemplatePin = Readonly<{
  provider: "iclr";
  conferenceYear: number;
  officialPageUrl: string;
  repositoryUrl: string;
  commit: string;
  archiveUrl: string;
  archiveSha256: string;
  archiveBytes: number;
  requiredFiles: readonly string[];
  licenseStatus: "not_declared_by_repository" | "declared";
  redistribution: "external_fetch_or_user_supplied_only" | "permitted";
  verifiedAt: string;
}>;

export type TemplateProbe = Readonly<{
  provider: "iclr";
  conferenceYear: number;
  status: "verified" | "structure_verified" | "unverified_year" | "missing" | "hash_mismatch" | "incomplete";
  pin?: ManuscriptTemplatePin;
  archive?: Readonly<{
    path: string;
    bytes: number;
    contentHash: string;
  }>;
  directory?: Readonly<{
    path: string;
    presentFiles: readonly string[];
    missingFiles: readonly string[];
  }>;
  diagnostics: readonly string[];
}>;

export type ManuscriptTarget = Readonly<{
  venue: "iclr" | "generic";
  conferenceYear?: number;
  mode: "anonymous_submission" | "camera_ready" | "internal_draft";
  maxMainPages?: number;
}>;

export type ManuscriptVersionPayload = Readonly<{
  schemaVersion: 1;
  kind: "manuscript_version";
  title: string;
  source: Readonly<{
    format: "latex";
    mainFile: "main.tex";
    content: string;
    contentHash: string;
    singleSourceOfTruth: true;
  }>;
  target: ManuscriptTarget;
  template?: ManuscriptTemplatePin;
  citationSetRef?: ResearchArtifactRef;
  figureTableRefs: readonly ResearchArtifactRef[];
  sections: readonly SectionGenerationContract[];
  sectionAudits: readonly SectionGenerationAudit[];
  relatedWork?: RelatedWorkPlan;
  appendix: Readonly<{
    enabled: boolean;
    commandPresent: boolean;
    afterBibliography: boolean;
  }>;
  revisionNote: string;
}>;

export type ManuscriptVersionArtifact = ResearchArtifactEnvelope<"manuscript_version", ManuscriptVersionPayload>;

export type LatexEngineName = "latexmk" | "tectonic" | "pdflatex" | "xelatex" | "lualatex";
export type BibliographyEngineName = "bibtex" | "biber";

export type EngineProbe = Readonly<{
  name: LatexEngineName | BibliographyEngineName | "pdfinfo";
  status: "available" | "absent" | "timed_out" | "error";
  executable?: string;
  version?: string;
  diagnostic?: string;
}>;

export type CompileDiagnostic = Readonly<{
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  file?: string;
  line?: number;
}>;

export type ManuscriptComplianceCheck = Readonly<{
  name: "compile" | "anonymity" | "page_limit" | "citations" | "appendix" | "template";
  status: "pass" | "warning" | "fail" | "not_checked";
  messages: readonly string[];
}>;

export type RenderOutputFile = Readonly<{
  kind: "pdf" | "tex" | "bib" | "log" | "diagnostics" | "manifest";
  path: string;
  contentHash: string;
  bytes: number;
  exported: boolean;
}>;

export type ManuscriptExportRequest = Readonly<{
  confirmed: boolean;
  outputDirectory: string;
  include: readonly ("pdf" | "tex" | "bib" | "log" | "diagnostics" | "manifest")[];
  overwrite?: boolean;
}>;

export type RenderRunPayload = Readonly<{
  schemaVersion: 1;
  kind: "render_run";
  manuscriptRef: ResearchArtifactRef;
  engine: EngineProbe;
  bibliographyEngine?: EngineProbe;
  command: readonly string[];
  exitCode: number | null;
  timedOut: boolean;
  compileStatus: "succeeded" | "failed" | "engine_unavailable";
  workingDirectory: string;
  diagnostics: readonly CompileDiagnostic[];
  checks: readonly ManuscriptComplianceCheck[];
  pageCount?: number;
  mainMatterPage?: number;
  outputs: readonly RenderOutputFile[];
  exportBoundary: Readonly<{
    requested: boolean;
    confirmed: boolean;
    performed: boolean;
    outputDirectory?: string;
  }>;
}>;

export type RenderRunArtifact = ResearchArtifactEnvelope<"render_run", RenderRunPayload>;

export type CreateCitationSetInput = Readonly<{
  zoteroItems?: readonly ZoteroCitationData[];
  bibtexEntries?: readonly BibtexEntryData[];
  producer: ResearchArtifactProducer;
  artifactId?: string;
  now?: Date;
}>;

export type CreateManuscriptVersionInput = Readonly<{
  title: string;
  latex: string;
  target: ManuscriptTarget;
  sections: readonly SectionGenerationContract[];
  revisionNote: string;
  producer: ResearchArtifactProducer;
  citationSet?: CitationSetArtifact;
  figureTables?: readonly FigureTableArtifact[];
  evidencePacks?: readonly EvidencePackArtifact[];
  relatedWork?: RelatedWorkPlan;
  template?: ManuscriptTemplatePin;
  supersedes?: ManuscriptVersionArtifact;
  artifactId?: string;
  revision?: number;
  now?: Date;
}>;
