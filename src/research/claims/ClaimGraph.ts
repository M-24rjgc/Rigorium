import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BeliefSnapshot,
  Claim,
  ClaimBelief,
  EvidenceContribution,
} from "./types.js";
import {
  aggregateContributions,
  computeBelief,
  type BeliefComputationOptions,
} from "./beliefPropagation.js";

export const CLAIMS_DIR_NAME = "claims";
export const CLAIMS_FILE_NAME = "claims.json";
export const MAX_CLAIMS_FILE_BYTES = 16 * 1024 * 1024;

/** Contract for the artifact-DAG loader: latest revisions, active status. */
export type ClaimEvidenceArtifact = Readonly<{
  artifactId: string;
  revision: number;
  kind: string;
  status?: string;
  parents?: readonly { relation: string; artifact: { artifactId: string; kind: string } }[];
  updatedAt?: string;
}>;

export type ClaimGraphOptions = {
  projectRoot: string;
  now?: () => Date;
  /**
   * Artifact DAG loader — returns artifacts (latest revision, active status)
   * for evidence harvest. REQUIRED: without it the claim graph is blind to
   * evidence and every recompute degrades to priors; callers must wire the
   * project artifact repository. Pass `() => []` explicitly only in tests
   * that exercise the empty-evidence path on purpose.
   */
  loadArtifacts: () => Promise<readonly ClaimEvidenceArtifact[]>;
};

type ClaimRecord = Readonly<{
  claim: Claim;
  /** Persisted status overrides (superseded) applied by graph operations. */
  statusOverride?: "superseded";
  supersededByClaimId?: string;
  supersededAt?: string;
}>;

type PersistedState = Readonly<{
  schemaVersion: 1;
  claims: ClaimRecord[];
}>;

/**
 * Module-level serialization of the claims file's read-modify-write.
 * Tool executions construct a fresh ClaimGraph per call, so an in-instance
 * mutex would not serialize concurrent writers (parallel subagents): two
 * concurrent upserts would both merge onto the same disk snapshot and the
 * last save would silently drop one. Keyed by file path so different
 * projects don't block each other.
 */
const CLAIM_WRITE_LOCKS = new Map<string, Promise<void>>();

function withClaimWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = CLAIM_WRITE_LOCKS.get(filePath) ?? Promise.resolve();
  const run = previous.then(fn);
  // Store a non-throwing tail so a failed op doesn't poison the chain.
  CLAIM_WRITE_LOCKS.set(
    filePath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Project-local claim graph with belief computation and atomic persistence.
 *
 * Claims are first-class research entities stored under
 * `<projectRoot>/.rigorium/research/claims/claims.json` (project isolation is
 * guaranteed by the path root). Evidence is *not* stored here — it is
 * harvested from the artifact DAG's `supports`/`challenges` parent edges at
 * recompute time, so the claim graph and the artifact graph can never drift.
 *
 * Durability invariants:
 * - a file that failed to parse is NEVER overwritten (its records are
 *   salvaged where possible, and the next save is refused until the graph
 *   has been rebuilt from a valid source);
 * - mutations commit to disk (temp + atomic rename) before the in-memory
 *   state is updated, so a failed save leaves memory consistent with disk.
 */
export class ClaimGraph {
  private readonly filePath: string;
  private readonly loadArtifacts: ClaimGraphOptions["loadArtifacts"];
  private readonly now: () => Date;
  private claims = new Map<string, ClaimRecord>();
  private loaded = false;
  /** True when the on-disk file existed but failed to parse. */
  private loadFailed = false;
  /** Cached evidence contributions per claim, refreshed on recompute. */
  private contributions = new Map<string, EvidenceContribution[]>();

  constructor(options: ClaimGraphOptions) {
    this.filePath = join(options.projectRoot, ".rigorium", "research", CLAIMS_DIR_NAME, CLAIMS_FILE_NAME);
    this.loadArtifacts = options.loadArtifacts;
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  async load(): Promise<void> {
    if (this.loaded) return;
    let fileExisted = false;
    try {
      const raw = await readFile(this.filePath, "utf8");
      fileExisted = true;
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed && Array.isArray(parsed.claims)) {
        // Salvage valid records individually: one malformed record must not
        // wipe the rest of the graph.
        let salvaged = 0;
        let dropped = 0;
        for (const record of parsed.claims) {
          try {
            const claim = record?.claim;
            if (!claim || typeof claim.claimId !== "string" || typeof claim.statement !== "string") {
              dropped += 1;
              continue;
            }
            this.claims.set(claim.claimId, record);
            salvaged += 1;
          } catch {
            dropped += 1;
          }
        }
        if (dropped > 0 && salvaged === 0) {
          // Nothing usable on disk — treat as corrupt, refuse to overwrite.
          this.loadFailed = true;
        }
      } else {
        // File exists and parses, but the shape is wrong (e.g. `{}` or
        // `{"claims":"x"}`). Same invariant as corrupt JSON: never overwrite
        // a file we did not author.
        this.loadFailed = true;
      }
    } catch {
      // Missing file → fresh graph. Corrupt JSON → refuse to overwrite.
      try {
        await readFile(this.filePath, "utf8");
        this.loadFailed = true;
      } catch {
        // genuinely missing — fine
      }
    }
    this.loaded = true;
    if (fileExisted && this.loadFailed) {
      // Surface the corruption once, loudly, instead of silently starting a
      // fresh graph that the next save() will refuse to persist.
      console.warn(
        `[rigorium] Claim graph at ${this.filePath} is corrupt or malformed; ` +
        "reads will see an empty graph and saves are refused until the file is repaired or removed.",
      );
    }
  }

  /**
   * Persist the given claim map atomically. Defaults to the current in-memory
   * map; mutations pass their *candidate* state so a failed save leaves
   * memory consistent with disk (the candidate is only committed after the
   * rename succeeds).
   */
  async save(claimsToWrite: ReadonlyMap<string, ClaimRecord> = this.claims): Promise<void> {
    if (this.loadFailed) {
      throw new Error(
        "Claim graph file is corrupt; refusing to overwrite it. Inspect and repair " +
        `${this.filePath} (or delete it to start fresh) before writing.`,
      );
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const state: PersistedState = {
      schemaVersion: 1,
      claims: [...claimsToWrite.values()],
    };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_CLAIMS_FILE_BYTES) {
      throw new Error(`Claim graph exceeds its size limit (${MAX_CLAIMS_FILE_BYTES} bytes).`);
    }
    const temporaryPath = join(dirname(this.filePath), `.${CLAIMS_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      // Best-effort temp cleanup; the in-memory state is untouched so the
      // caller can retry or recover without divergence.
      try {
        const { rm } = await import("node:fs/promises");
        await rm(temporaryPath, { force: true });
      } catch {
        // ignore
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Claim CRUD
  // -------------------------------------------------------------------------

  async upsertClaim(input: {
    claimId: string;
    statement: string;
    falsificationCondition?: string;
    parentClaimIds?: string[];
    sourceArtifactId?: string;
  }): Promise<Claim> {
    return withClaimWriteLock(this.filePath, async () => {
      await this.load();
      const existing = this.claims.get(input.claimId);
      const claim: Claim = Object.freeze({
        claimId: input.claimId,
        statement: input.statement,
        falsificationCondition: input.falsificationCondition,
        parentClaimIds: input.parentClaimIds ? [...input.parentClaimIds] : undefined,
        sourceArtifactId: input.sourceArtifactId,
        createdAt: existing?.claim.createdAt ?? this.now().toISOString(),
      });
      const next = new Map(this.claims);
      next.set(input.claimId, {
        claim,
        statusOverride: existing?.statusOverride,
        supersededByClaimId: existing?.supersededByClaimId,
        supersededAt: existing?.supersededAt,
      });
      await this.save(next);
      this.claims = next;
      return claim;
    });
  }

  async listClaims(): Promise<Claim[]> {
    await this.load();
    return [...this.claims.values()].map((record) => record.claim);
  }

  async getClaim(claimId: string): Promise<Claim | undefined> {
    await this.load();
    return this.claims.get(claimId)?.claim;
  }

  /**
   * Mark a claim superseded (and its descendants transitively). This is the
   * belief-revision path: a superseding claim replaces the falsified one and
   * everything derived from it stops being planned against. The superseding
   * claim id propagates to all descendants so the revision trail is complete.
   */
  async supersedeClaim(input: { claimId: string; supersededByClaimId: string; reason?: string }): Promise<string[]> {
    return withClaimWriteLock(this.filePath, async () => {
      await this.load();
      const existing = this.claims.get(input.claimId);
      if (!existing) {
        throw new Error(`Cannot supersede unknown claim "${input.claimId}".`);
      }
      if (input.claimId === input.supersededByClaimId) {
        // A claim cannot be its own successor — that would pin it superseded
        // with a self-referential chain and no revision to point at.
        throw new Error(`Cannot supersede claim "${input.claimId}" with itself.`);
      }
      if (!this.claims.has(input.supersededByClaimId)) {
        // A supersession chain must point at a real claim — otherwise the
        // revision trail dangles and downstream replanning reads garbage.
        throw new Error(
          `Cannot supersede "${input.claimId}" with unknown claim "${input.supersededByClaimId}".`,
        );
      }
      if (existing.supersededByClaimId) {
        // Already superseded: a second supersede would fork the revision
        // chain, silently dropping the first successor from the trail.
        throw new Error(
          `Cannot supersede "${input.claimId}": already superseded by "${existing.supersededByClaimId}".`,
        );
      }
      const affected = this.collectDescendants(input.claimId);
      const nowIso = this.now().toISOString();
      const next = new Map(this.claims);
      for (const claimId of affected) {
        const record = next.get(claimId);
        if (!record) continue;
        next.set(claimId, {
          ...record,
          statusOverride: "superseded",
          supersededByClaimId: input.supersededByClaimId,
          supersededAt: nowIso,
        });
      }
      await this.save(next);
      this.claims = next;
      return affected;
    });
  }

  private collectDescendants(claimId: string): string[] {
    const children = new Map<string, string[]>();
    for (const record of this.claims.values()) {
      for (const parent of record.claim.parentClaimIds ?? []) {
        const list = children.get(parent) ?? [];
        list.push(record.claim.claimId);
        children.set(parent, list);
      }
    }
    const visited = new Set<string>();
    const stack = [claimId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const child of children.get(current) ?? []) {
        stack.push(child);
      }
    }
    return [...visited];
  }

  // -------------------------------------------------------------------------
  // Belief computation
  // -------------------------------------------------------------------------

  /**
   * Recompute beliefs from the artifact DAG's supports/challenges edges.
   * Returns the full belief snapshot; persists nothing (beliefs are derived).
   * Throws when no artifact loader was wired (evidence-blind graphs are a
   * wiring error, not a silent degradation).
   */
  async recomputeBeliefs(options?: BeliefComputationOptions): Promise<BeliefSnapshot> {
    await this.load();
    const claims = [...this.claims.values()];
    const artifacts = await this.loadArtifacts();
    const claimIds = new Set(claims.map((record) => record.claim.claimId));
    this.contributions = aggregateContributions(artifacts, claimIds, this.now().toISOString());

    const beliefs: ClaimBelief[] = claims.map((record) => {
      const belief = computeBelief(record.claim, this.contributions.get(record.claim.claimId) ?? [], options);
      if (record.statusOverride === "superseded") {
        return Object.freeze({
          ...belief,
          status: "superseded" as const,
        });
      }
      return belief;
    });
    return Object.freeze({
      computedAt: this.now().toISOString(),
      beliefs,
    });
  }

  /** Last harvested evidence contributions (after a recompute). */
  contributionsFor(claimId: string): readonly EvidenceContribution[] {
    return this.contributions.get(claimId) ?? [];
  }

  /** Convenience: claims with the highest remaining uncertainty (EIG inputs). */
  async mostUncertainClaims(limit = 5): Promise<ClaimBelief[]> {
    const snapshot = await this.recomputeBeliefs();
    return [...snapshot.beliefs]
      .filter((belief) => belief.status === "active")
      .sort((left, right) => right.uncertainty - left.uncertainty)
      .slice(0, limit);
  }
}
