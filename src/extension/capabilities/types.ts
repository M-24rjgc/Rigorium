import type { InputModality } from "../../model/index.js";

/**
 * A machine-checkable capability contract.
 *
 * Plugins declare capabilities in `plugin.json` under `settings.capabilities`
 * (either legacy strings like `"manuscript.render.deterministic_diagnostics"`
 * or full contract objects). The registry promotes those declarations into
 * first-class, machine-readable contracts that:
 *
 * - the research director can merge into its capability snapshot
 *   (accepts/produces/dependsOnCapabilityIds mirror `ResearchDirectorCapability`),
 * - the router can read for modality requirements (e.g. a figure-rendering
 *   capability needs a multimodal model),
 * - the UI can enumerate (capability list RPC).
 */
export type RigoriumCapability = Readonly<{
  /** Stable machine id, e.g. "manuscript.render.deterministic_diagnostics". */
  id: string;
  /** Human-readable short name (optional; defaults to the id). */
  name?: string;
  description?: string;
  /** Owning plugin name; set by the registry, not by the manifest. */
  plugin?: string;
  /** Artifact kinds this capability accepts as input (director-compatible). */
  accepts?: readonly string[];
  /** Artifact kinds this capability produces (director-compatible). */
  produces?: readonly string[];
  dependsOnCapabilityIds?: readonly string[];
  /** Input modalities required by the model that executes this capability. */
  modalityRequirements?: readonly InputModality[];
  concurrencySafe?: boolean;
  /** Rough cost estimate in director cost units. */
  estimatedCostUnits?: number;
  estimatedDurationMs?: number;
  requiresUserConfirmation?: boolean;
}>;

export type CapabilityValidationIssue = {
  capabilityId: string;
  code: "dangling_dependency" | "empty_id";
  message: string;
};

/**
 * Legacy string capability declarations (e.g. plugin manifests written before
 * the contract format) are promoted to contracts with only an id. The full
 * contract fields are optional and filled in by the declaring plugin.
 */
export type CapabilityDeclaration = string | Omit<RigoriumCapability, "plugin">;
