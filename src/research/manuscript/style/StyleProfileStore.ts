import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { StyleProfile } from "./types.js";

/**
 * Style-profile store: one fine-grained style profile per venue per project,
 * persisted under `<projectRoot>/.rigorium/research/venues/styles/<venueId>.json`.
 *
 * The profile is produced by the agent from the venue corpus; the store
 * validates its structure (so a malformed "analysis" cannot silently poison
 * later writing) and keeps revision history via superseding.
 */

export type StyleProfileStoreOptions = {
  projectRoot: string;
  now?: () => Date;
};

export type StyleProfileSaveResult = Readonly<{
  saved: StyleProfile;
  /** True when this save replaced an earlier profile for the same venue. */
  superseded: boolean;
  supersededAt?: string;
}>;

export class StyleProfileStore {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(options: StyleProfileStoreOptions) {
    this.dir = join(options.projectRoot, ".rigorium", "research", "venues", "styles");
    this.now = options.now ?? (() => new Date());
  }

  /** Load the current profile for a venue (undefined when none exists). */
  async get(venue: string): Promise<StyleProfile | undefined> {
    try {
      const raw = await readFile(this.profilePath(venue), "utf8");
      const parsed = JSON.parse(raw) as StyleProfile;
      return validateStyleProfile(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<StyleProfile[]> {
    const { readdir } = await import("node:fs/promises");
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const profiles: StyleProfile[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const profile = await this.get(entry.replace(/\.json$/u, ""));
      if (profile) profiles.push(profile);
    }
    return profiles.sort((left, right) => left.venue.localeCompare(right.venue, "en"));
  }

  /** Save a profile (validated); a same-venue save supersedes the previous. */
  async save(input: StyleProfile): Promise<StyleProfileSaveResult> {
    if (!validateStyleProfile(input)) {
      throw new Error(
        "Invalid style profile: venue, computedAt, and learnedFrom are required; " +
        "storyArc/sentenceTemplates/paragraphPatterns/figureConventions must be arrays.",
      );
    }
    const profile = input;
    const previous = await this.get(profile.venue);
    await mkdir(this.dir, { recursive: true });
    const temporaryPath = join(this.dir, `.${profile.venue}.json.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.profilePath(profile.venue));
    return Object.freeze({
      saved: profile,
      superseded: previous !== undefined,
      ...(previous ? { supersededAt: this.now().toISOString() } : {}),
    });
  }

  private profilePath(venue: string): string {
    return join(this.dir, `${safeVenueId(venue)}.json`);
  }
}

export function safeVenueId(venue: string): string {
  const sanitized = venue.replace(/[^a-zA-Z0-9._-]/gu, "-");
  return sanitized.length > 0 ? sanitized : "venue";
}

export function validateStyleProfile(value: unknown): value is StyleProfile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.venue !== "string" || record.venue.length === 0) return false;
  if (typeof record.computedAt !== "string") return false;
  if (!Array.isArray(record.learnedFrom)) return false;
  for (const key of ["storyArc", "sentenceTemplates", "paragraphPatterns", "figureConventions"]) {
    if (record[key] !== undefined && !Array.isArray(record[key])) return false;
  }
  return true;
}
