import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BUILTIN_VENUES } from "./venueRegistry.js";
import type { VenueDefinition } from "./venueRegistry.js";
import { resolveTemplateSources, type TemplateResolution } from "./templateResolver.js";

export const VENUES_DIR_NAME = "venues";
export const VENUES_FILE_NAME = "venues.json";

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
    } catch {
      // Missing/corrupt override file → builtins only.
    }
    this.loaded = true;
  }

  /** Persist project-level custom venues (atomic write). */
  async save(venues: readonly VenueDefinition[]): Promise<void> {
    await mkdir(dirname(this.overridePath), { recursive: true });
    const state = { schemaVersion: 1, venues };
    const temporaryPath = join(dirname(this.overridePath), `.${VENUES_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.overridePath);
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
