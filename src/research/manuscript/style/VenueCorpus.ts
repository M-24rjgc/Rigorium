import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Venue corpus: the ~10 high-quality papers the style profile is learned
 * from. One corpus per project, papers tagged by venue and evicted per venue,
 * persisted under
 * `<projectRoot>/.rigorium/research/venues/corpus/corpus.json`.
 *
 * The corpus is *collected by the agent* (via literature search, OpenReview,
 * arXiv, Zotero) — this store only records what was collected and why it was
 * chosen, so the learning process is auditable.
 */

export type CorpusPaper = Readonly<{
  paperId: string;
  title: string;
  venue: string;
  year: number;
  /** Selection rationale: best paper award / review score / survey / user. */
  selection: "best_paper" | "high_score" | "survey" | "user" | "other";
  /** Public source (openreview | arxiv | zotero | other). */
  source: string;
  sourceUrl?: string;
  /** Local PDF path (agent-downloaded). */
  pdfPath?: string;
  /** Local LaTeX source path when available. */
  texPath?: string;
  /** Number of pages, when known. */
  pageCount?: number;
  addedAt: string;
}>;

export type VenueCorpusState = Readonly<{
  schemaVersion: 1;
  venue: string;
  papers: readonly CorpusPaper[];
}>;

export type VenueCorpusOptions = {
  projectRoot: string;
  now?: () => Date;
  /**
   * Per-venue corpus size cap. Eviction is venue-scoped: adding a paper for
   * venue X can only evict other papers of venue X — collecting for a second
   * venue must never silently evict the first venue's exemplars.
   */
  maxPapers?: number;
};

export const DEFAULT_MAX_CORPUS_PAPERS = 10;

export type AddCorpusPaperResult = Readonly<{
  paper: CorpusPaper;
  /** Papers evicted by the per-venue size cap (oldest-first, same venue). */
  evicted: readonly CorpusPaper[];
}>;

export class VenueCorpus {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly maxPapers: number;
  private papers: CorpusPaper[] = [];
  private loaded = false;

  constructor(options: VenueCorpusOptions) {
    this.filePath = join(options.projectRoot, ".rigorium", "research", "venues", "corpus", "corpus.json");
    this.now = options.now ?? (() => new Date());
    this.maxPapers = options.maxPapers ?? DEFAULT_MAX_CORPUS_PAPERS;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as VenueCorpusState;
      if (parsed && Array.isArray(parsed.papers)) {
        this.papers = parsed.papers.filter(isCorpusPaper);
      }
    } catch {
      // missing/corrupt → empty corpus
    }
    this.loaded = true;
  }

  /** Add a paper (dedup by paperId; keeps the latest). */
  async addPaper(input: Omit<CorpusPaper, "addedAt">): Promise<AddCorpusPaperResult> {
    await this.load();
    const paper: CorpusPaper = Object.freeze({
      ...input,
      addedAt: this.now().toISOString(),
    });
    const next = this.papers.filter((existing) => existing.paperId !== paper.paperId);
    next.push(paper);
    // Corpus size is bounded per venue by design (fine-grained learning needs
    // depth, not volume); exceeding papers of the SAME venue are dropped
    // oldest-first and reported — never silent, never cross-venue.
    const evicted: CorpusPaper[] = [];
    while (next.filter((candidate) => candidate.venue === paper.venue).length > this.maxPapers) {
      const victim = next.find((candidate) => candidate.venue === paper.venue);
      if (!victim) break;
      const victimIndex = next.indexOf(victim);
      next.splice(victimIndex, 1);
      evicted.push(victim);
    }
    await this.save(next);
    this.papers = next;
    return Object.freeze({ paper, evicted: Object.freeze(evicted) });
  }

  async listPapers(): Promise<CorpusPaper[]> {
    await this.load();
    return [...this.papers];
  }

  async getPaper(paperId: string): Promise<CorpusPaper | undefined> {
    await this.load();
    return this.papers.find((paper) => paper.paperId === paperId);
  }

  async removePaper(paperId: string): Promise<boolean> {
    await this.load();
    const next = this.papers.filter((paper) => paper.paperId !== paperId);
    if (next.length === this.papers.length) {
      return false;
    }
    await this.save(next);
    this.papers = next;
    return true;
  }

  async size(): Promise<number> {
    await this.load();
    return this.papers.length;
  }

  private async save(papers: CorpusPaper[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const state: VenueCorpusState = { schemaVersion: 1, venue: "corpus", papers };
    const temporaryPath = join(dirname(this.filePath), `.corpus.json.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

function isCorpusPaper(value: unknown): value is CorpusPaper {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.paperId === "string" &&
    typeof record.title === "string" &&
    typeof record.venue === "string" &&
    typeof record.year === "number"
  );
}
