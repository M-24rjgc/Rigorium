import { toResearchArtifactRef, type ResearchArtifactRef } from "../../research/artifacts/index.js";
import type { ResearchBriefArtifact } from "../../research/design/index.js";
import {
  assertIsolatedMethodWorkspace,
  createImplementationSnapshotArtifact,
  createMethodSpecArtifact,
  reviseMethodSpecArtifact,
  runVerificationCheck,
  type ImplementationSnapshotArtifact,
  type MethodSpecArtifact,
  type MethodSpecInput,
  type ObservedConclusion,
  type VerificationRecord,
} from "../../research/method/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationIssue, PilotDeckToolValidationResult } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

export type ResearchMethodToolInput =
  | Readonly<{
    action: "create_spec";
    brief: ResearchBriefArtifact;
    spec: MethodSpecInput;
  }>
  | Readonly<{
    action: "revise_spec";
    brief: ResearchBriefArtifact;
    previousMethodSpec: MethodSpecArtifact;
    spec: Omit<MethodSpecInput, "artifactId" | "revision">;
  }>
  | Readonly<{
    action: "run_checks";
    methodSpec: MethodSpecArtifact;
    routeId: string;
    workspaceRoot: string;
  }>
  | Readonly<{
    action: "capture_snapshot";
    methodSpec: MethodSpecArtifact;
    routeId: string;
    workspaceRoot: string;
    configFiles?: readonly string[];
    verificationRecords?: readonly VerificationRecord[];
    observedConclusions?: readonly ObservedConclusion[];
  }>;

export type ResearchMethodToolResult =
  | Readonly<{
    action: "create_spec";
    methodSpec: MethodSpecArtifact;
  }>
  | Readonly<{
    action: "revise_spec";
    methodSpec: MethodSpecArtifact;
  }>
  | Readonly<{
    action: "run_checks";
    methodSpecRef: ResearchArtifactRef;
    routeId: string;
    verificationRecords: readonly VerificationRecord[];
  }>
  | Readonly<{
    action: "capture_snapshot";
    snapshot: ImplementationSnapshotArtifact;
  }>;

export type CreateResearchMethodToolOptions = Readonly<{
  maxResultBytes?: number;
}>;

export function createResearchMethodTool(
  options: CreateResearchMethodToolOptions = {},
): PilotDeckToolDefinition<ResearchMethodToolInput, ResearchMethodToolResult> {
  return {
    name: "research_method",
    title: "Specify and Verify a Research Method",
    description: `Create or revise an executable MethodSpec from a ready ResearchBrief, run its declared unit, numerical, and smoke checks, or capture a read-only ImplementationSnapshot.

Use action=create_spec or revise_spec to materialize mathematical definitions, assumptions, pseudocode, model structure, procedures, complexity, counterexamples, failure boundaries, interfaces, isolated implementation routes, checks, and expected conclusions. Use run_checks only with a dedicated workspace outside the current Project; the Project root is always the tool runtime cwd and cannot be overridden. Use capture_snapshot after checks to hash the route's source and test files plus explicit config files, preserving the user worktree and keeping expected conclusions distinct from observed conclusions. This tool does not search literature, commit Git state, run a shell, control AgentLoop, or advance a fixed workflow stage.`,
    kind: "custom",
    inputSchema: researchMethodInputSchema(),
    maxResultBytes: positiveInteger(options.maxResultBytes) ?? 3_000_000,
    isReadOnly: (input) => input.action !== "run_checks",
    isConcurrencySafe: (input) => input.action !== "run_checks",
    isOpenWorld: () => false,
    validateInput: async (input, context) => validateInput(input, context),
    execute: async (input, context) => {
      try {
        const result = await executeAction(input, context);
        return formatOutput(result);
      } catch (error) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", `Invalid research method action: ${messageOf(error)}`);
      }
    },
  };
}

async function executeAction(
  input: ResearchMethodToolInput,
  context: PilotDeckToolRuntimeContext,
): Promise<ResearchMethodToolResult> {
  requireActionInput(input);
  const now = context.now?.();
  if (input.action === "create_spec") {
    return {
      action: "create_spec",
      methodSpec: createMethodSpecArtifact({
        brief: input.brief,
        spec: { ...input.spec, now },
        producer: { kind: "tool", toolName: "research_method" },
      }),
    };
  }
  if (input.action === "revise_spec") {
    return {
      action: "revise_spec",
      methodSpec: reviseMethodSpecArtifact({
        brief: input.brief,
        previous: input.previousMethodSpec,
        spec: { ...input.spec, now },
        producer: { kind: "tool", toolName: "research_method" },
      }),
    };
  }
  const route = methodRoute(input.methodSpec, input.routeId);
  const workspaceRoot = await assertIsolatedMethodWorkspace({
    projectRoot: context.cwd,
    workspaceRoot: input.workspaceRoot,
  });
  if (input.action === "run_checks") {
    const checks = new Map(input.methodSpec.payload.verificationChecks.map((check) => [check.id, check]));
    const verificationRecords: VerificationRecord[] = [];
    for (const checkId of route.verificationCheckIds) {
      const check = checks.get(checkId);
      if (!check) throw new TypeError(`Route ${route.id} references missing verification check ${checkId}.`);
      verificationRecords.push(await runVerificationCheck({
        projectRoot: context.cwd,
        workspaceRoot,
        check,
        abortSignal: context.abortSignal,
        now,
      }));
    }
    return Object.freeze({
      action: "run_checks" as const,
      methodSpecRef: toResearchArtifactRef(input.methodSpec),
      routeId: route.id,
      verificationRecords: Object.freeze(verificationRecords),
    });
  }
  const snapshot = await createImplementationSnapshotArtifact({
    methodSpec: input.methodSpec,
    routeId: route.id,
    implementationRoot: workspaceRoot,
    configFiles: input.configFiles,
    verificationRecords: input.verificationRecords,
    observedConclusions: input.observedConclusions,
    producer: { kind: "tool", toolName: "research_method" },
    now,
  });
  return Object.freeze({ action: "capture_snapshot" as const, snapshot });
}

async function validateInput(
  input: ResearchMethodToolInput,
  context: PilotDeckToolRuntimeContext,
): Promise<PilotDeckToolValidationResult> {
  try {
    requireActionInput(input);
    const validationDate = new Date("2000-01-01T00:00:00.000Z");
    if (input.action === "create_spec") {
      createMethodSpecArtifact({ brief: input.brief, spec: { ...input.spec, now: validationDate } });
    } else if (input.action === "revise_spec") {
      reviseMethodSpecArtifact({
        brief: input.brief,
        previous: input.previousMethodSpec,
        spec: { ...input.spec, now: validationDate },
      });
    } else {
      methodRoute(input.methodSpec, input.routeId);
      await assertIsolatedMethodWorkspace({ projectRoot: context.cwd, workspaceRoot: input.workspaceRoot });
      if (input.action === "capture_snapshot") {
        if (input.configFiles !== undefined && !Array.isArray(input.configFiles)) throw new TypeError("configFiles must be an array.");
        if (input.verificationRecords !== undefined && !Array.isArray(input.verificationRecords)) {
          throw new TypeError("verificationRecords must be an array.");
        }
        if (input.observedConclusions !== undefined && !Array.isArray(input.observedConclusions)) {
          throw new TypeError("observedConclusions must be an array.");
        }
      }
    }
    return { ok: true, input };
  } catch (error) {
    const issue: PilotDeckToolValidationIssue = { path: "$", code: "invalid_schema", message: messageOf(error) };
    return { ok: false, issues: [issue] };
  }
}

function methodRoute(methodSpec: MethodSpecArtifact, routeId: string) {
  if (!methodSpec || methodSpec.kind !== "method_spec" || methodSpec.status !== "active"
    || methodSpec.payload?.kind !== "method_spec" || methodSpec.payload.status !== "executable") {
    throw new TypeError("An active executable MethodSpec is required.");
  }
  if (typeof routeId !== "string" || !routeId.trim() || routeId !== routeId.trim()) {
    throw new TypeError("routeId must be non-empty text.");
  }
  const route = methodSpec.payload.implementationRoutes.find((candidate) => candidate.id === routeId);
  if (!route) throw new TypeError(`MethodSpec has no route ${routeId}.`);
  return route;
}

function requireActionInput(value: unknown): asserts value is ResearchMethodToolInput {
  if (!isRecord(value) || !["create_spec", "revise_spec", "run_checks", "capture_snapshot"].includes(String(value.action))) {
    throw new TypeError("research_method requires a supported action.");
  }
  if (value.action === "create_spec" && (!value.brief || !value.spec)) {
    throw new TypeError("create_spec requires brief and spec.");
  }
  if (value.action === "revise_spec" && (!value.brief || !value.previousMethodSpec || !value.spec)) {
    throw new TypeError("revise_spec requires brief, previousMethodSpec, and spec.");
  }
  if ((value.action === "run_checks" || value.action === "capture_snapshot")
    && (!value.methodSpec || typeof value.routeId !== "string" || typeof value.workspaceRoot !== "string")) {
    throw new TypeError(`${value.action} requires methodSpec, routeId, and workspaceRoot.`);
  }
}

function researchMethodInputSchema() {
  return {
    type: "object" as const,
    additionalProperties: true,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["create_spec", "revise_spec", "run_checks", "capture_snapshot"] },
      brief: { type: "object" },
      previousMethodSpec: { type: "object" },
      spec: { type: "object" },
      methodSpec: { type: "object" },
      routeId: { type: "string" },
      workspaceRoot: { type: "string" },
      configFiles: { type: "array", items: { type: "string" } },
      verificationRecords: { type: "array", items: { type: "object" } },
      observedConclusions: { type: "array", items: { type: "object" } },
    },
  };
}

function formatOutput(result: ResearchMethodToolResult): PilotDeckToolExecutionOutput<ResearchMethodToolResult> {
  let lines: string[];
  let metadata: Record<string, unknown>;
  if (result.action === "create_spec" || result.action === "revise_spec") {
    lines = [
      "Research method specification",
      `Action: ${result.action}`,
      `Artifact: ${result.methodSpec.artifactId}@${result.methodSpec.revision}`,
      `Routes: ${result.methodSpec.payload.implementationRoutes.length}`,
      `Checks: ${result.methodSpec.payload.verificationChecks.length}`,
    ];
    metadata = { action: result.action, artifactId: result.methodSpec.artifactId, revision: result.methodSpec.revision };
  } else if (result.action === "run_checks") {
    lines = [
      "Research method verification",
      `Route: ${result.routeId}`,
      `Checks: ${result.verificationRecords.length}`,
      `Passed: ${result.verificationRecords.filter((record) => record.status === "passed").length}`,
    ];
    metadata = { action: result.action, routeId: result.routeId, checkCount: result.verificationRecords.length };
  } else {
    lines = [
      "Research implementation snapshot",
      `Artifact: ${result.snapshot.artifactId}@${result.snapshot.revision}`,
      `Route: ${result.snapshot.payload.routeId}`,
      `Files: ${result.snapshot.payload.files.length}`,
    ];
    metadata = { action: result.action, artifactId: result.snapshot.artifactId, routeId: result.snapshot.payload.routeId };
  }
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "json", value: result },
    ],
    data: result,
    metadata,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
