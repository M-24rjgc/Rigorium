import type {
  CapabilityValidationIssue,
  RigoriumCapability,
} from "./types.js";

/**
 * In-process registry of machine-checkable capability contracts.
 *
 * Lives inside the gateway (one instance per project runtime, owned by
 * `PluginRuntime`). It is the single source of truth for what the currently
 * loaded plugins can do — the research director merges these contracts into
 * its planning snapshot, the router reads modality requirements from them,
 * and the UI enumerates them over the gateway RPC.
 */
export class CapabilityRegistry {
  private readonly byId = new Map<string, RigoriumCapability>();

  /** Replace all entries (used by plugin refresh). */
  replaceAll(capabilities: readonly RigoriumCapability[]): void {
    this.byId.clear();
    for (const capability of capabilities) {
      this.byId.set(capability.id, capability);
    }
  }

  register(capability: RigoriumCapability): void {
    this.byId.set(capability.id, capability);
  }

  get(id: string): RigoriumCapability | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): RigoriumCapability[] {
    return [...this.byId.values()];
  }

  /** Capabilities declared by a specific plugin. */
  forPlugin(pluginName: string): RigoriumCapability[] {
    return [...this.byId.values()].filter((capability) => capability.plugin === pluginName);
  }

  /** Capabilities that produce a given artifact kind. */
  findProducers(producesKind: string): RigoriumCapability[] {
    return [...this.byId.values()].filter((capability) =>
      (capability.produces ?? []).includes(producesKind),
    );
  }

  /** Capabilities that accept a given artifact kind as input. */
  findAcceptors(acceptsKind: string): RigoriumCapability[] {
    return [...this.byId.values()].filter((capability) =>
      (capability.accepts ?? []).includes(acceptsKind),
    );
  }

  /**
   * Report dangling `dependsOnCapabilityIds` references — dependencies that no
   * loaded plugin declares. Used by validation surfaces so a plugin that
   * depends on a missing capability is surfaced instead of silently degraded.
   */
  validateDependencies(): CapabilityValidationIssue[] {
    const issues: CapabilityValidationIssue[] = [];
    for (const capability of this.byId.values()) {
      for (const dependency of capability.dependsOnCapabilityIds ?? []) {
        if (!this.byId.has(dependency)) {
          issues.push({
            capabilityId: capability.id,
            code: "dangling_dependency",
            message: `capability "${capability.id}" depends on "${dependency}" which no loaded plugin declares`,
          });
        }
      }
    }
    return issues;
  }

  size(): number {
    return this.byId.size;
  }
}
