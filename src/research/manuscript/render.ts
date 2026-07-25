import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactParent,
  type ResearchArtifactProducer,
} from "../artifacts/index.js";
import type {
  BibliographyEngineName,
  CitationSetArtifact,
  CompileDiagnostic,
  EngineProbe,
  FigureTableArtifact,
  LatexEngineName,
  ManuscriptComplianceCheck,
  ManuscriptExportRequest,
  ManuscriptVersionArtifact,
  RenderOutputFile,
  RenderRunArtifact,
  RenderRunPayload,
  TemplateProbe,
} from "./types.js";
import { verifyFigureTableArtifactFiles } from "./figureTable.js";
import { containsActiveLatexCommand, extractLatexCitationKeys } from "./manuscript.js";
import { getOfficialIclrTemplatePin, probeIclrTemplate } from "./template.js";
import {
  hashBytes,
  requirePositiveInteger,
  requireText,
  resolveWithin,
  stripLatexComments,
  uniqueSorted,
} from "./validation.js";

const MAX_COMMAND_OUTPUT = 4_000_000;
const FORCE_KILL_DELAY_MS = 500;
const FORCE_RESOLVE_DELAY_MS = 5_000;
const TEMPLATE_EXTENSIONS = new Set([".sty", ".bst", ".cls", ".tex"]);
const ENGINE_ORDER: readonly LatexEngineName[] = ["latexmk", "tectonic", "pdflatex", "xelatex", "lualatex"];
const PROBE_ORDER: readonly EngineProbe["name"][] = [
  "latexmk", "tectonic", "pdflatex", "xelatex", "lualatex", "bibtex", "biber", "pdfinfo",
];
const LATEX_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
] as const;
const TEX_FILE_ACCESS_BOUNDARY = Object.freeze({
  openin_any: "p",
  openout_any: "p",
});

export type CommandRunRequest = Readonly<{
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type CommandRunResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
  errorMessage?: string;
}>;

export type ManuscriptCommandRunner = (request: CommandRunRequest) => Promise<CommandRunResult>;

export type RenderManuscriptInput = Readonly<{
  projectRoot: string;
  manuscript: ManuscriptVersionArtifact;
  citationSet?: CitationSetArtifact;
  figureTables?: readonly FigureTableArtifact[];
  templateDirectory?: string;
  /**
   * Optional official template archive used to verify the directory against its
   * pinned digest. The archive is inspected only; source files are staged from
   * templateDirectory.
   */
  templateArchive?: string;
  engine?: "auto" | LatexEngineName;
  timeoutMs?: number;
  export?: ManuscriptExportRequest;
  producer: ResearchArtifactProducer;
  artifactId?: string;
  now?: Date;
  signal?: AbortSignal;
}>;

export type RenderManuscriptOptions = Readonly<{
  runner?: ManuscriptCommandRunner;
  engineProbes?: readonly EngineProbe[];
  probeTimeoutMs?: number;
}>;

export function createNodeManuscriptCommandRunner(): ManuscriptCommandRunner {
  return (request) => new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let forceResolveTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandRunResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceResolveTimer) clearTimeout(forceResolveTimer);
      request.signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_COMMAND_OUTPUT) return current;
      return `${current}${chunk.toString("utf8")}`.slice(0, MAX_COMMAND_OUTPUT);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(Object.freeze({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        ...(error.code === undefined ? {} : { errorCode: error.code }),
        errorMessage: error.message,
      }));
    });
    child.on("close", (code) => finish(Object.freeze({ exitCode: code, stdout, stderr, timedOut })));
    const forceResolve = (reason: "aborted" | "timed_out") => {
      forceResolveTimer ??= setTimeout(() => finish(Object.freeze({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        errorCode: reason === "timed_out" ? "ETIMEDOUT" : "ABORT_ERR",
        errorMessage: `Compiler process did not close within ${FORCE_RESOLVE_DELAY_MS}ms after termination.`,
      })), FORCE_RESOLVE_DELAY_MS);
      forceResolveTimer.unref();
    };
    const forceKill = () => {
      const pid = child.pid;
      if (!pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        try {
          const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
            env: buildLatexEnvironment(0),
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => undefined);
          killer.unref();
        } catch { /* best-effort process-tree termination */ }
        try { child.kill("SIGKILL"); } catch { /* process may already have exited */ }
        return;
      }
      try { process.kill(-pid, "SIGKILL"); } catch { /* process group may already have exited */ }
    };
    const stop = (reason: "aborted" | "timed_out") => {
      const pid = child.pid;
      if (pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          forceKill();
        } else {
          try { process.kill(-pid, "SIGTERM"); } catch { /* process group may already have exited */ }
          forceKillTimer ??= setTimeout(forceKill, FORCE_KILL_DELAY_MS);
          forceKillTimer.unref();
        }
      }
      forceResolve(reason);
    };
    const onAbort = () => {
      timedOut = false;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      stop("aborted");
    };
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop("timed_out");
    }, request.timeoutMs);
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function detectLatexEngines(input: {
  runner?: ManuscriptCommandRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<EngineProbe[]> {
  const runner = input.runner ?? createNodeManuscriptCommandRunner();
  const timeoutMs = input.timeoutMs ?? 3_000;
  const env = buildLatexEnvironment(0);
  return Promise.all(PROBE_ORDER.map(async (name): Promise<EngineProbe> => {
    const request = probeCommand(name);
    const result = await runner({
      executable: request.executable,
      args: request.args,
      env,
      timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.errorCode === "ENOENT") return Object.freeze({ name, status: "absent" as const });
    if (result.timedOut) return Object.freeze({ name, status: "timed_out" as const, executable: request.executable, diagnostic: "Version probe timed out." });
    if (result.exitCode !== 0) {
      return Object.freeze({
        name,
        status: "error" as const,
        executable: request.executable,
        diagnostic: firstMeaningfulLine(`${result.stderr}\n${result.stdout}`) || result.errorMessage || `Exited with ${result.exitCode}.`,
      });
    }
    return Object.freeze({
      name,
      status: "available" as const,
      executable: request.executable,
      version: firstMeaningfulLine(`${result.stdout}\n${result.stderr}`) || "version output unavailable",
    });
  }));
}

export async function renderManuscript(
  input: RenderManuscriptInput,
  options: RenderManuscriptOptions = {},
): Promise<RenderRunArtifact> {
  const projectRoot = resolve(input.projectRoot);
  await assertSafeProjectRoot(projectRoot);
  assertArtifactLinks(input);
  const runner = options.runner ?? createNodeManuscriptCommandRunner();
  const probes = options.engineProbes
    ? [...options.engineProbes]
    : await detectLatexEngines({
        runner,
        timeoutMs: options.probeTimeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
  const selected = selectEngine(probes, input.engine ?? "auto");
  const bibliographyProbe = probes.find((probe) => probe.name === "bibtex" && probe.status === "available")
    ?? probes.find((probe) => probe.name === "biber" && probe.status === "available");
  const workspace = await mkdtemp(join(tmpdir(), "rigorium-manuscript-"));
  const buildDirectory = join(workspace, "build");
  await mkdir(buildDirectory, { recursive: true });
  await writeFile(join(workspace, "main.tex"), input.manuscript.payload.source.content, { encoding: "utf8", flag: "wx" });
  if (input.citationSet) {
    await writeFile(join(workspace, "references.bib"), input.citationSet.payload.bibtex, { encoding: "utf8", flag: "wx" });
  }

  let templateProbe: TemplateProbe | undefined;
  if (input.manuscript.payload.target.venue === "iclr") {
    templateProbe = await probeIclrTemplate({
      conferenceYear: input.manuscript.payload.target.conferenceYear!,
      ...(input.templateArchive === undefined ? {} : { archivePath: input.templateArchive }),
      ...(input.templateDirectory === undefined ? {} : { directoryPath: input.templateDirectory }),
    });
  }
  if (input.templateDirectory !== undefined && (templateProbe === undefined || ["verified", "structure_verified"].includes(templateProbe.status))) {
    await stageTemplateDirectory(input.templateDirectory, workspace);
  }
  await stageFigureTableOutputs(projectRoot, input.figureTables ?? [], workspace);

  if (!selected) {
    return createRenderRunArtifact(input, {
      schemaVersion: 1,
      kind: "render_run",
      manuscriptRef: toResearchArtifactRef(input.manuscript),
      engine: requestedUnavailableProbe(input.engine ?? "auto"),
      command: [],
      exitCode: null,
      timedOut: false,
      compileStatus: "engine_unavailable",
      workingDirectory: workspace,
      diagnostics: [Object.freeze({ severity: "error", code: "engine_unavailable", message: "No supported LaTeX engine is available." })],
      checks: baseUnavailableChecks(templateProbe),
      outputs: await collectSourceOutputs(workspace, input.citationSet !== undefined),
      exportBoundary: exportBoundary(input.export, false),
    });
  }

  const timeoutMs = requirePositiveInteger(input.timeoutMs ?? 120_000, "timeoutMs", 15 * 60_000);
  const command = renderCommand(selected.name as LatexEngineName, buildDirectory);
  const createdAtSeconds = Math.floor(Date.parse(input.manuscript.createdAt) / 1_000);
  const env = buildLatexEnvironment(Number.isFinite(createdAtSeconds) ? createdAtSeconds : 0);
  const runs: CommandRunResult[] = [];
  runs.push(await runner({
    executable: command[0]!,
    args: command.slice(1),
    cwd: workspace,
    env,
    timeoutMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }));
  if (selected.name !== "latexmk" && selected.name !== "tectonic" && runs[0]?.exitCode === 0 && !runs[0].timedOut) {
    runs.push(await runner({
      executable: command[0]!,
      args: command.slice(1),
      cwd: workspace,
      env,
      timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }));
  }
  const finalRun = runs.at(-1)!;
  const logPath = join(buildDirectory, "main.log");
  const log = await readTextIfExists(logPath);
  const diagnostics = parseLatexDiagnostics(`${log}\n${runs.map((run) => `${run.stdout}\n${run.stderr}`).join("\n")}`);
  const pdfPath = join(buildDirectory, "main.pdf");
  const pdfExists = await isRegularFile(pdfPath);
  const compileSucceeded = finalRun.exitCode === 0 && !finalRun.timedOut && pdfExists;
  const pdfInfoProbe = probes.find((probe) => probe.name === "pdfinfo" && probe.status === "available");
  const pageCount = compileSucceeded && pdfInfoProbe
    ? await readPdfPageCount(pdfInfoProbe.executable ?? "pdfinfo", pdfPath, workspace, timeoutMs, runner, env, input.signal)
    : undefined;
  const aux = await readTextIfExists(join(buildDirectory, "main.aux"));
  const mainMatterPage = readAuxLabelPage(aux, "pilotdeck-main-matter-end");
  const checks = buildComplianceChecks({
    manuscript: input.manuscript,
    citationSet: input.citationSet,
    templateProbe,
    diagnostics,
    compileSucceeded,
    pageCount,
    mainMatterPage,
  });
  await writeFile(join(workspace, "diagnostics.json"), `${JSON.stringify({ diagnostics, checks }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const outputsBeforeManifest = await collectRenderOutputs(workspace, buildDirectory, input.citationSet !== undefined);
  const manifest = {
    schemaVersion: 1,
    manuscript: toResearchArtifactRef(input.manuscript),
    engine: selected,
    command,
    exitCode: finalRun.exitCode,
    timedOut: runs.some((run) => run.timedOut),
    checks,
    outputs: outputsBeforeManifest.map(({ kind, path, contentHash, bytes }) => ({ kind, file: basename(path), contentHash, bytes })),
  };
  await writeFile(join(workspace, "render-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  let outputs = await collectRenderOutputs(workspace, buildDirectory, input.citationSet !== undefined, true);
  let exportPerformed = false;
  if (input.export?.confirmed === true) {
    outputs = await exportOutputs({ projectRoot, request: input.export, outputs });
    exportPerformed = true;
  }
  return createRenderRunArtifact(input, {
    schemaVersion: 1,
    kind: "render_run",
    manuscriptRef: toResearchArtifactRef(input.manuscript),
    engine: selected,
    ...(bibliographyProbe === undefined ? {} : { bibliographyEngine: bibliographyProbe }),
    command,
    exitCode: finalRun.exitCode,
    timedOut: runs.some((run) => run.timedOut),
    compileStatus: compileSucceeded ? "succeeded" : "failed",
    workingDirectory: workspace,
    diagnostics,
    checks,
    ...(pageCount === undefined ? {} : { pageCount }),
    ...(mainMatterPage === undefined ? {} : { mainMatterPage }),
    outputs,
    exportBoundary: exportBoundary(input.export, exportPerformed),
  });
}

export function parseLatexDiagnostics(text: string): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    let match = /^!\s*(.+)$/u.exec(line);
    if (match) {
      diagnostics.push({ severity: "error", code: "latex_error", message: match[1]!.trim() });
      continue;
    }
    match = /^(.+?\.tex):(\d+):\s*(.+)$/u.exec(line);
    if (match) {
      diagnostics.push({ severity: "error", code: "file_line_error", file: basename(match[1]!), line: Number(match[2]), message: match[3]!.trim() });
      continue;
    }
    match = /^(?:LaTeX|Package\s+\S+) Warning:\s*(.+)$/u.exec(line);
    if (match) {
      const message = match[1]!.trim();
      diagnostics.push({ severity: "warning", code: warningCode(message), message });
      continue;
    }
    if (/^(?:Overfull|Underfull)\s+\\[hv]box/u.test(line)) {
      diagnostics.push({ severity: "warning", code: "box_warning", message: line });
      continue;
    }
    if (/\\end occurred inside a group/iu.test(line)) {
      diagnostics.push({ severity: "warning", code: "unclosed_group", message: line.replace(/^\(/u, "") });
    }
  }
  const unique = new Map<string, CompileDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.severity}|${diagnostic.code}|${diagnostic.file ?? ""}|${diagnostic.line ?? ""}|${diagnostic.message}`;
    unique.set(key, Object.freeze(diagnostic));
  }
  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  return [...unique.values()].sort((left, right) => {
    return severityRank[left.severity] - severityRank[right.severity]
      || left.code.localeCompare(right.code, "en")
      || (left.file ?? "").localeCompare(right.file ?? "", "en")
      || (left.line ?? 0) - (right.line ?? 0)
      || left.message.localeCompare(right.message, "en");
  });
}

function buildComplianceChecks(input: {
  manuscript: ManuscriptVersionArtifact;
  citationSet?: CitationSetArtifact;
  templateProbe?: TemplateProbe;
  diagnostics: readonly CompileDiagnostic[];
  compileSucceeded: boolean;
  pageCount?: number;
  mainMatterPage?: number;
}): ManuscriptComplianceCheck[] {
  return [
    compileCheck(input.compileSucceeded, input.diagnostics),
    anonymityCheck(input.manuscript),
    pageLimitCheck(input.manuscript, input.pageCount, input.mainMatterPage),
    citationCheck(input.manuscript, input.citationSet, input.diagnostics),
    appendixCheck(input.manuscript),
    templateCheck(input.manuscript, input.templateProbe),
  ];
}

function compileCheck(succeeded: boolean, diagnostics: readonly CompileDiagnostic[]): ManuscriptComplianceCheck {
  if (!succeeded) return check("compile", "fail", ["The selected engine did not produce a successful PDF render."]);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) return check("compile", "warning", [`PDF produced with ${errors.length} parsed error diagnostics.`]);
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  return check("compile", warnings > 0 ? "warning" : "pass", warnings > 0 ? [`PDF produced with ${warnings} deterministic warnings.`] : []);
}

function anonymityCheck(manuscript: ManuscriptVersionArtifact): ManuscriptComplianceCheck {
  const target = manuscript.payload.target;
  if (target.mode !== "anonymous_submission") return check("anonymity", "not_checked", ["Target is not an anonymous submission."]);
  const source = manuscript.payload.source.content;
  const failures: string[] = [];
  const warnings: string[] = [];
  if (containsActiveLatexCommand(source, "iclrfinalcopy")) failures.push("Active \\iclrfinalcopy exposes the camera-ready author block.");
  if (/\\pdfinfo\s*\{[^}]*(?:Author|Creator)\s*=/iu.test(stripLatexComments(source))) warnings.push("PDF metadata may contain author or creator identity.");
  if (/\\section\*?\s*\{\s*Acknowledg/iu.test(stripLatexComments(source))) warnings.push("Acknowledgements are present in an anonymous submission source.");
  if (failures.length > 0) return check("anonymity", "fail", [...failures, ...warnings]);
  return check("anonymity", warnings.length > 0 ? "warning" : "pass", warnings);
}

function pageLimitCheck(
  manuscript: ManuscriptVersionArtifact,
  pageCount: number | undefined,
  mainMatterPage: number | undefined,
): ManuscriptComplianceCheck {
  const limit = manuscript.payload.target.maxMainPages;
  if (limit === undefined) return check("page_limit", "not_checked", ["No main-matter page limit is configured."]);
  if (mainMatterPage !== undefined) {
    return mainMatterPage <= limit
      ? check("page_limit", "pass", [`Main-matter marker resolves to page ${mainMatterPage}; limit is ${limit}.`])
      : check("page_limit", "fail", [`Main-matter marker resolves to page ${mainMatterPage}; limit is ${limit}.`]);
  }
  if (pageCount !== undefined && pageCount <= limit) {
    return check("page_limit", "pass", [`Total PDF length is ${pageCount} pages, within the ${limit}-page main-matter limit.`]);
  }
  return check("page_limit", "warning", [
    `Main-matter page marker \\label{pilotdeck-main-matter-end} was not resolved${pageCount === undefined ? "" : `; total PDF length is ${pageCount}`}.`,
  ]);
}

function citationCheck(
  manuscript: ManuscriptVersionArtifact,
  citationSet: CitationSetArtifact | undefined,
  diagnostics: readonly CompileDiagnostic[],
): ManuscriptComplianceCheck {
  const cited = extractLatexCitationKeys(manuscript.payload.source.content);
  if (cited.length === 0) return check("citations", "pass", []);
  if (!citationSet) return check("citations", "fail", ["LaTeX cites keys but no CitationSet was supplied to the render."]);
  const available = new Set(citationSet.payload.citationKeys);
  const missing = cited.filter((key) => !available.has(key));
  const logUndefined = diagnostics.some((diagnostic) => diagnostic.code === "undefined_citation");
  if (missing.length > 0 || logUndefined) {
    return check("citations", "fail", [
      ...(missing.length === 0 ? [] : [`CitationSet is missing: ${missing.join(", ")}.`]),
      ...(logUndefined ? ["The LaTeX log reports undefined citations."] : []),
    ]);
  }
  return check("citations", "pass", [`Resolved ${cited.length} unique citation keys against CitationSet.`]);
}

function appendixCheck(manuscript: ManuscriptVersionArtifact): ManuscriptComplianceCheck {
  const appendix = manuscript.payload.appendix;
  if (!appendix.enabled) return check("appendix", "not_checked", ["No appendix command is present."]);
  if (!appendix.afterBibliography) return check("appendix", "fail", ["Appendix begins before the bibliography boundary."]);
  const hasMarker = new RegExp(`\\\\label\\{pilotdeck-appendix-start\\}`, "u").test(stripLatexComments(manuscript.payload.source.content));
  return check("appendix", hasMarker ? "pass" : "warning", hasMarker ? [] : ["Appendix is ordered correctly but lacks the pilotdeck-appendix-start marker."]);
}

function templateCheck(manuscript: ManuscriptVersionArtifact, probe: TemplateProbe | undefined): ManuscriptComplianceCheck {
  const target = manuscript.payload.target;
  if (target.venue !== "iclr") return check("template", "not_checked", ["Generic venue target does not require an ICLR template pin."]);
  const official = getOfficialIclrTemplatePin(target.conferenceYear!);
  if (!official) return check("template", "fail", [`No verified official ICLR ${target.conferenceYear} template pin exists in this build.`]);
  if (!manuscript.payload.template || manuscript.payload.template.commit !== official.commit || manuscript.payload.template.archiveSha256 !== official.archiveSha256) {
    return check("template", "fail", ["ManuscriptVersion does not carry the verified official template pin."]);
  }
  if (!probe || !["verified", "structure_verified"].includes(probe.status)) {
    return check("template", "fail", [`Local template probe status is ${probe?.status ?? "missing"}.`]);
  }
  return check("template", probe.status === "verified" ? "pass" : "warning", probe.status === "verified"
    ? []
    : ["Required template files are present, but the local directory was not reconstructed from a hash-verified archive in this render call."]);
}

function check(
  name: ManuscriptComplianceCheck["name"],
  status: ManuscriptComplianceCheck["status"],
  messages: readonly string[],
): ManuscriptComplianceCheck {
  return Object.freeze({ name, status, messages: Object.freeze([...messages]) });
}

async function stageTemplateDirectory(sourceDirectory: string, workspace: string): Promise<void> {
  const source = resolve(sourceDirectory);
  const stats = await lstat(source);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TypeError("Template directory must be a non-symlink directory.");
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !TEMPLATE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    if (entry.name === "main.tex") throw new TypeError("Template directory must not override the canonical main.tex source.");
    const inputPath = join(source, entry.name);
    const inputStats = await lstat(inputPath);
    if (inputStats.isSymbolicLink() || !inputStats.isFile()) throw new TypeError(`Template file ${entry.name} is unsafe.`);
    await copyFile(inputPath, join(workspace, entry.name), fsConstants.COPYFILE_EXCL);
  }
}

async function stageFigureTableOutputs(
  projectRoot: string,
  artifacts: readonly FigureTableArtifact[],
  workspace: string,
): Promise<void> {
  for (const artifact of artifacts) {
    const verification = await verifyFigureTableArtifactFiles({ projectRoot, artifact });
    if (verification.status !== "verified") {
      const failures = verification.files.filter((file) => file.status !== "verified").map((file) => `${file.path}:${file.status}`);
      throw new TypeError(`FigureTable file verification failed: ${failures.join(", ")}.`);
    }
    for (const item of artifact.payload.items) {
      const source = resolveWithin(projectRoot, resolve(projectRoot, item.output.path), `figure/table output ${item.output.path}`);
      const destination = resolveWithin(workspace, resolve(workspace, item.output.path), `staged figure/table output ${item.output.path}`);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    }
  }
}

async function collectSourceOutputs(workspace: string, hasBib: boolean): Promise<RenderOutputFile[]> {
  const candidates: Array<{ kind: RenderOutputFile["kind"]; path: string }> = [{ kind: "tex", path: join(workspace, "main.tex") }];
  if (hasBib) candidates.push({ kind: "bib", path: join(workspace, "references.bib") });
  return collectFiles(candidates, false);
}

async function collectRenderOutputs(
  workspace: string,
  buildDirectory: string,
  hasBib: boolean,
  includeManifest = false,
): Promise<RenderOutputFile[]> {
  const candidates: Array<{ kind: RenderOutputFile["kind"]; path: string }> = [
    { kind: "tex", path: join(workspace, "main.tex") },
    { kind: "pdf", path: join(buildDirectory, "main.pdf") },
    { kind: "log", path: join(buildDirectory, "main.log") },
    { kind: "diagnostics", path: join(workspace, "diagnostics.json") },
  ];
  if (hasBib) candidates.push({ kind: "bib", path: join(workspace, "references.bib") });
  if (includeManifest) candidates.push({ kind: "manifest", path: join(workspace, "render-manifest.json") });
  return collectFiles(candidates, false);
}

async function collectFiles(
  candidates: readonly { kind: RenderOutputFile["kind"]; path: string }[],
  exported: boolean,
): Promise<RenderOutputFile[]> {
  const outputs: RenderOutputFile[] = [];
  for (const candidate of candidates) {
    if (!await isRegularFile(candidate.path)) continue;
    const content = await readFile(candidate.path);
    outputs.push(Object.freeze({
      kind: candidate.kind,
      path: candidate.path,
      contentHash: hashBytes(content),
      bytes: content.byteLength,
      exported,
    }));
  }
  return outputs;
}

async function exportOutputs(input: {
  projectRoot: string;
  request: ManuscriptExportRequest;
  outputs: readonly RenderOutputFile[];
}): Promise<RenderOutputFile[]> {
  const outputDirectory = resolveWithin(input.projectRoot, resolve(input.projectRoot, input.request.outputDirectory), "export outputDirectory");
  await assertNoSymlinkPath(input.projectRoot, outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const directoryStats = await lstat(outputDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) throw new TypeError("Export outputDirectory must be a non-symlink directory.");
  const include = new Set(input.request.include);
  const exported: RenderOutputFile[] = [];
  for (const output of input.outputs) {
    if (!include.has(output.kind)) continue;
    const destination = join(outputDirectory, exportFileName(output.kind));
    await copyFile(output.path, destination, input.request.overwrite === true ? 0 : fsConstants.COPYFILE_EXCL);
    const content = await readFile(destination);
    exported.push(Object.freeze({
      kind: output.kind,
      path: destination,
      contentHash: hashBytes(content),
      bytes: content.byteLength,
      exported: true,
    }));
  }
  return exported;
}

async function assertNoSymlinkPath(projectRoot: string, target: string): Promise<void> {
  const rel = relative(projectRoot, target);
  const segments = rel.split(sep).filter(Boolean);
  let current = projectRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new TypeError(`Export path traverses symbolic link ${current}.`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
}

function exportFileName(kind: RenderOutputFile["kind"]): string {
  const names: Record<RenderOutputFile["kind"], string> = {
    pdf: "manuscript.pdf",
    tex: "manuscript.tex",
    bib: "references.bib",
    log: "manuscript.log",
    diagnostics: "diagnostics.json",
    manifest: "render-manifest.json",
  };
  return names[kind];
}

function createRenderRunArtifact(input: RenderManuscriptInput, payload: RenderRunPayload): RenderRunArtifact {
  const parents: ResearchArtifactParent[] = [{ relation: "uses", artifact: toResearchArtifactRef(input.manuscript) }];
  if (input.citationSet) parents.push({ relation: "uses", artifact: toResearchArtifactRef(input.citationSet) });
  for (const figure of input.figureTables ?? []) parents.push({ relation: "uses", artifact: toResearchArtifactRef(figure) });
  return createResearchArtifact({
    kind: "render_run",
    payload,
    producer: input.producer,
    parents,
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

function assertArtifactLinks(input: RenderManuscriptInput): void {
  if (input.manuscript.payload.citationSetRef) {
    if (!input.citationSet || !sameRef(input.manuscript.payload.citationSetRef, toResearchArtifactRef(input.citationSet))) {
      throw new TypeError("Render requires the exact CitationSet referenced by ManuscriptVersion.");
    }
  }
  const suppliedFigures = new Map((input.figureTables ?? []).map((artifact) => {
    const ref = toResearchArtifactRef(artifact);
    return [`${ref.artifactId}@${ref.revision}`, ref];
  }));
  const missing = input.manuscript.payload.figureTableRefs.find((ref) => !sameRef(ref, suppliedFigures.get(`${ref.artifactId}@${ref.revision}`)));
  if (missing) throw new TypeError(`Render requires FigureTable ${missing.artifactId}@${missing.revision}.`);
}

function sameRef(left: { artifactId: string; revision: number; contentHash: string }, right: { artifactId: string; revision: number; contentHash: string } | undefined): boolean {
  return right !== undefined && left.artifactId === right.artifactId && left.revision === right.revision && left.contentHash === right.contentHash;
}

function selectEngine(probes: readonly EngineProbe[], requested: "auto" | LatexEngineName): EngineProbe | undefined {
  const available = new Map(probes.filter((probe) => probe.status === "available").map((probe) => [probe.name, probe]));
  if (requested !== "auto") return available.get(requested);
  return ENGINE_ORDER.map((name) => available.get(name)).find((probe) => probe !== undefined);
}

function requestedUnavailableProbe(requested: "auto" | LatexEngineName): EngineProbe {
  return Object.freeze({
    name: requested === "auto" ? "latexmk" : requested,
    status: "absent" as const,
    diagnostic: requested === "auto" ? "No supported engine was detected." : `${requested} was requested but is unavailable.`,
  });
}

function probeCommand(name: EngineProbe["name"]): { executable: string; args: string[] } {
  if (name === "latexmk") return { executable: "latexmk", args: ["-v"] };
  if (name === "pdfinfo") return { executable: "pdfinfo", args: ["-v"] };
  return { executable: name, args: ["--version"] };
}

function renderCommand(name: LatexEngineName, buildDirectory: string): string[] {
  if (name === "latexmk") {
    return ["latexmk", "-norc", "-pdf", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", `-outdir=${buildDirectory}`, "main.tex"];
  }
  if (name === "tectonic") {
    return ["tectonic", "--untrusted", "--keep-logs", "--keep-intermediates", "--outdir", buildDirectory, "main.tex"];
  }
  return [name, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", `-output-directory=${buildDirectory}`, "main.tex"];
}

async function readPdfPageCount(
  executable: string,
  pdfPath: string,
  cwd: string,
  timeoutMs: number,
  runner: ManuscriptCommandRunner,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const result = await runner({ executable, args: [pdfPath], cwd, env, timeoutMs: Math.min(timeoutMs, 10_000), ...(signal === undefined ? {} : { signal }) });
  if (result.exitCode !== 0) return undefined;
  const match = /^Pages:\s+(\d+)\s*$/imu.exec(result.stdout);
  return match ? Number(match[1]) : undefined;
}

function buildLatexEnvironment(sourceDateEpoch: number, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const inheritedKeys = Object.keys(inherited);
  for (const key of LATEX_ENVIRONMENT_KEYS) {
    const inheritedKey = inheritedKeys.find((candidate) => candidate.toUpperCase() === key.toUpperCase());
    if (inheritedKey !== undefined && inherited[inheritedKey] !== undefined) env[key] = inherited[inheritedKey];
  }
  env.SOURCE_DATE_EPOCH = String(Math.max(0, Math.floor(sourceDateEpoch)));
  env.FORCE_SOURCE_DATE = "1";
  env.TZ = "UTC";
  applyTexFileAccessBoundary(env);
  return env;
}

function applyTexFileAccessBoundary(environment: NodeJS.ProcessEnv): void {
  // Kpathsea evaluates this after macro expansion, covering literal and indirect file access.
  for (const [key, value] of Object.entries(TEX_FILE_ACCESS_BOUNDARY)) environment[key] = value;
}

function readAuxLabelPage(aux: string, label: string): number | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`\\\\newlabel\\{${escaped}\\}\\{\\{[^}]*\\}\\{(\\d+)\\}`, "u").exec(aux);
  return match ? Number(match[1]) : undefined;
}

function warningCode(message: string): string {
  if (/undefined.*citation|Citation.*undefined/iu.test(message)) return "undefined_citation";
  if (/undefined.*reference|Reference.*undefined/iu.test(message)) return "undefined_reference";
  if (/rerun/iu.test(message)) return "rerun_required";
  return "latex_warning";
}

function firstMeaningfulLine(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.trim()).find((line) => line && !/^perl: warning/iu.test(line)) ?? "";
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "";
    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function assertSafeProjectRoot(projectRoot: string): Promise<void> {
  const stats = await lstat(projectRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TypeError("Project root must be an existing non-symlink directory.");
}

function exportBoundary(request: ManuscriptExportRequest | undefined, performed: boolean): RenderRunPayload["exportBoundary"] {
  return Object.freeze({
    requested: request !== undefined,
    confirmed: request?.confirmed === true,
    performed,
    ...(request === undefined ? {} : { outputDirectory: request.outputDirectory }),
  });
}

function baseUnavailableChecks(templateProbe: TemplateProbe | undefined): ManuscriptComplianceCheck[] {
  return [
    check("compile", "fail", ["No supported LaTeX engine is available."]),
    check("anonymity", "not_checked", ["No PDF was rendered."]),
    check("page_limit", "not_checked", ["No PDF was rendered."]),
    check("citations", "not_checked", ["No PDF was rendered."]),
    check("appendix", "not_checked", ["No PDF was rendered."]),
    check("template", templateProbe && ["verified", "structure_verified"].includes(templateProbe.status) ? "warning" : "fail", [
      `Template probe status: ${templateProbe?.status ?? "not_checked"}.`,
    ]),
  ];
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
