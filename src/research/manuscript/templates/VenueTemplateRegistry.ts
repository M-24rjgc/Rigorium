import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BUILTIN_VENUES } from "./venueRegistry.js";
import type { VenueDefinition, VenueTemplateSource } from "./venueRegistry.js";
import { resolveTemplateSources, type TemplateResolution } from "./templateResolver.js";

export const VENUES_DIR_NAME = "venues";
export const VENUES_FILE_NAME = "venues.json";

/**
 * Module-level serialization of the override file's read-modify-write.
 * The venue_template tool instantiates a fresh registry per call, so an
 * in-instance mutex would not serialize concurrent pins: two parallel pins
 * would both merge onto the same disk snapshot and the last save would
 * silently drop one pin. Keyed by override path so different projects don't
 * block each other.
 */
const OVERRIDE_FILE_LOCKS = new Map<string, Promise<void>>();

function withOverrideFileLock<T>(overridePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = OVERRIDE_FILE_LOCKS.get(overridePath) ?? Promise.resolve();
  const run = previous.then(fn);
  // Store a non-throwing tail so a failed op doesn't poison the chain.
  OVERRIDE_FILE_LOCKS.set(
    overridePath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Open venue registry: built-in catalog + project-level custom venues.
 *
 * The project override file lives at
 * `<projectRoot>/.rigorium/research/venues/venues.json` and *adds* or
 * *replaces* venues by id — a lab can register its own target journals
 * without touching the product code. The registry never decides anything;
 * it only answers queries the agent asks (list / get / resolve).
 */
export class VenueTemplateRegistry {
  private readonly overridePath: string;
  private readonly now: () => Date;
  private builtins = new Map<string, VenueDefinition>();
  private overrides = new Map<string, VenueDefinition>();
  private loaded = false;
  /** Set when the override file exists but failed to parse (see save). */
  private corruptOverride = false;

  constructor(options: { projectRoot: string; now?: () => Date }) {
    this.overridePath = join(
      options.projectRoot,
      ".rigorium",
      "research",
      VENUES_DIR_NAME,
      VENUES_FILE_NAME,
    );
    this.now = options.now ?? (() => new Date());
    this.builtins = new Map(BUILTIN_VENUES.map((venue) => [venue.id, venue]));
  }

  /** Register a custom venue (programmatic extension point). */
  register(venue: VenueDefinition): void {
    this.overrides.set(venue.id, venue);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.overridePath, "utf8");
      const parsed = JSON.parse(raw) as { venues?: VenueDefinition[] };
      if (Array.isArray(parsed.venues)) {
        for (const venue of parsed.venues) {
          if (venue && typeof venue.id === "string" && Array.isArray(venue.sources)) {
            this.overrides.set(venue.id, venue);
          }
        }
      }
      this.corruptOverride = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Missing file → builtins only; first save creates it.
        this.corruptOverride = false;
      } else {
        // Corrupt override must not be silently discarded and overwritten —
        // the next save would destroy whatever evidence it held.
        this.corruptOverride = true;
      }
    }
    this.loaded = true;
  }

  /** Persist project-level custom venues (atomic write). */
  async save(venues: readonly VenueDefinition[]): Promise<void> {
    if (this.corruptOverride) {
      throw new Error(
        `Refusing to overwrite corrupt venue override file at ${this.overridePath}. Inspect or remove the file first.`,
      );
    }
    await mkdir(dirname(this.overridePath), { recursive: true });
    const state = { schemaVersion: 1, venues };
    const temporaryPath = join(dirname(this.overridePath), `.${VENUES_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.overridePath);
  }

  /**
   * Pin a verified template source for a venue. Read-modify-write runs
   * under a module-level lock with a fresh disk read inside, so concurrent
   * pins merge instead of last-writer-wins.
   */
  async pinSource(input: { venueId: string; source: VenueTemplateSource }): Promise<VenueDefinition> {
    return withOverrideFileLock(this.overridePath, async () => {
      // Re-read from disk so this pin merges on top of any concurrent pin.
      this.loaded = false;
      await this.load();
      const venue = this.overrides.get(input.venueId) ?? this.builtins.get(input.venueId);
      if (!venue) {
        throw new Error(`Cannot pin a template to unregistered venue "${input.venueId}".`);
      }
      const custom = [...this.overrides.values()];
      const updated: VenueDefinition[] = custom.some((entry) => entry.id === venue.id)
        ? custom.map((entry) =>
            entry.id === venue.id
              ? Object.freeze({
                  ...entry,
                  // Merge, never replace: other verified pins (other years,
                  // evergreen fallbacks) stay available for year-adjusted
                  // resolution. The new pin leads for its own year.
                  sources: Object.freeze([
                    input.source,
                    ...entry.sources.filter(
                      (source) => !(source.year === input.source.year && source.verified),
                    ),
                  ]),
                })
              : entry,
          )
        : [
            ...custom,
            Object.freeze({
              id: venue.id,
              kind: venue.kind,
              displayName: venue.displayName,
              publisher: venue.publisher,
              anonymousSubmission: venue.anonymousSubmission,
              defaultPageLimit: venue.defaultPageLimit,
              sources: Object.freeze([
                input.source,
                ...venue.sources.filter(
                  (source) => !(source.year === input.source.year && source.verified),
                ),
              ]),
            }),
          ];
      this.overrides = new Map(updated.map((entry) => [entry.id, entry]));
      await this.save(updated);
      const merged = updated.find((entry) => entry.id === venue.id);
      if (!merged) {
        throw new Error(`Pin failed: venue "${input.venueId}" vanished during merge.`);
      }
      return merged;
    });
  }

  async listVenues(): Promise<VenueDefinition[]> {
    await this.load();
    const merged = new Map(this.builtins);
    for (const [id, venue] of this.overrides) {
      merged.set(id, venue);
    }
    return [...merged.values()];
  }

  async getVenue(id: string): Promise<VenueDefinition | undefined> {
    await this.load();
    return this.overrides.get(id) ?? this.builtins.get(id);
  }

  async resolve(id: string, requestedYear?: number): Promise<TemplateResolution | undefined> {
    const venue = await this.getVenue(id);
    if (!venue) {
      return undefined;
    }
    return resolveTemplateSources(venue, requestedYear);
  }

  /** Custom venues only (for the UI / diagnostics). */
  async customVenues(): Promise<VenueDefinition[]> {
    await this.load();
    return [...this.overrides.values()];
  }
}
