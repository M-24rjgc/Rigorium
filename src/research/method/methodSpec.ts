import { randomUUID } from "node:crypto";
import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactParent,
  type ResearchArtifactProducer,
} from "../artifacts/index.js";
import type { ResearchBriefArtifact } from "../design/contracts.js";
import type {
  ComplexityClaim,
  ExpectedConclusion,
  ImplementationInterface,
  ImplementationRoute,
  MathematicalDefinition,
  MethodAssumption,
  MethodCounterexample,
  MethodFailureBoundary,
  MethodProcedure,
  MethodSpecArtifact,
  MethodSpecInput,
  MethodSpecPayload,
  ModelComponent,
  PseudocodeBlock,
  VerificationCheckSpec,
} from "./contracts.js";

export function createMethodSpecArtifact(input: {
  brief: ResearchBriefArtifact;
  spec: MethodSpecInput;
  producer?: ResearchArtifactProducer;
  parents?: readonly ResearchArtifactParent[];
}): MethodSpecArtifact {
  assertExecutableBrief(input.brief);
  const payload = normalizeMethodSpecPayload(input.brief, input.spec);
  return createResearchArtifact({
    kind: "method_spec",
    artifactId: input.spec.artifactId ?? `method-spec-${randomUUID()}`,
    revision: input.spec.revision,
    payload,
    producer: input.producer ?? { kind: "tool", toolName: "research_method" },
    parents: [
      { relation: "derived_from", artifact: toResearchArtifactRef(input.brief) },
      ...(input.parents ?? []),
    ],
    sources: input.brief.sources,
    now: input.spec.now,
  }) as MethodSpecArtifact;
}

export function reviseMethodSpecArtifact(input: {
  previous: MethodSpecArtifact;
  brief: ResearchBriefArtifact;
  spec: Omit<MethodSpecInput, "artifactId" | "revision">;
  producer?: ResearchArtifactProducer;
}): MethodSpecArtifact {
  if (input.previous.payload.researchBriefRef.artifactId !== input.brief.artifactId) {
    throw new TypeError("A MethodSpec revision must stay attached to the same ResearchBrief identity.");
  }
  return createMethodSpecArtifact({
    brief: input.brief,
    spec: {
      ...input.spec,
      artifactId: input.previous.artifactId,
      revision: input.previous.revision + 1,
    },
    producer: input.producer,
    parents: [{ relation: "supersedes", artifact: toResearchArtifactRef(input.previous) }],
  });
}

function normalizeMethodSpecPayload(brief: ResearchBriefArtifact, input: MethodSpecInput): MethodSpecPayload {
  const definitions = normalizeDefinitions(input.definitions);
  const assumptions = normalizeAssumptions(input.assumptions);
  const pseudocode = normalizePseudocode(input.pseudocode);
  const modelStructure = normalizeModelComponents(input.modelStructure ?? []);
  const trainingProcedure = normalizeProcedure(input.trainingProcedure, "trainingProcedure");
  const inferenceProcedure = normalizeProcedure(input.inferenceProcedure, "inferenceProcedure");
  const complexity = normalizeComplexity(input.complexity);
  const counterexamples = normalizeCounterexamples(input.counterexamples, new Set(assumptions.map((item) => item.id)));
  const failureBoundaries = normalizeFailureBoundaries(input.failureBoundaries);
  const interfaces = normalizeInterfaces(input.interfaces);
  const checks = normalizeVerificationChecks(input.verificationChecks);
  const routes = normalizeRoutes(
    input.implementationRoutes,
    new Set(interfaces.map((item) => item.id)),
    new Set(checks.map((item) => item.id)),
  );
  requireAllReferenced("implementation interface", interfaces.map((item) => item.id), routes.flatMap((route) => route.interfaceIds));
  requireAllReferenced("verification check", checks.map((item) => item.id), routes.flatMap((route) => route.verificationCheckIds));
  const conclusions = normalizeExpectedConclusions(input.expectedConclusions, new Set(checks.map((item) => item.id)));
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "method_spec" as const,
    researchBriefRef: toResearchArtifactRef(brief),
    researchQuestion: brief.payload.question,
    mechanism: brief.payload.mechanism,
    definitions,
    assumptions,
    pseudocode,
    modelStructure,
    trainingProcedure,
    inferenceProcedure,
    complexity,
    counterexamples,
    failureBoundaries,
    interfaces,
    implementationRoutes: routes,
    verificationChecks: checks,
    expectedConclusions: conclusions,
    nonGoals: normalizeTextList(input.nonGoals ?? [], "nonGoals", 64),
    status: "executable" as const,
  });
}

function assertExecutableBrief(brief: ResearchBriefArtifact): void {
  if (!brief || brief.kind !== "research_brief" || brief.payload.kind !== "research_brief") {
    throw new TypeError("MethodSpec requires a ResearchBrief artifact.");
  }
  if (brief.payload.status !== "ready" || brief.payload.candidateId === null) {
    throw new TypeError("MethodSpec requires a ready ResearchBrief with a selected candidate.");
  }
}

function normalizeDefinitions(values: readonly MathematicalDefinition[]): MathematicalDefinition[] {
  requireCount(values, "definitions", 1, 128);
  return normalizeIdentified(values, "definitions", (value, label) => Object.freeze({
    id: identifier(value.id, `${label}.id`),
    symbol: text(value.symbol, `${label}.symbol`, 256),
    domain: text(value.domain, `${label}.domain`, 2_000),
    definition: text(value.definition, `${label}.definition`, 8_000),
    ...(value.units === undefined ? {} : { units: text(value.units, `${label}.units`, 512) }),
  }));
}

function normalizeAssumptions(values: readonly MethodAssumption[]): MethodAssumption[] {
  requireCount(values, "assumptions", 1, 128);
  return normalizeIdentified(values, "assumptions", (value, label) => Object.freeze({
    id: identifier(value.id, `${label}.id`),
    statement: text(value.statement, `${label}.statement`, 8_000),
    scope: text(value.scope, `${label}.scope`, 4_000),
    justification: text(value.justification, `${label}.justification`, 8_000),
    falsifiable: boolean(value.falsifiable, `${label}.falsifiable`),
    evidenceIds: normalizeIdentifiers(value.evidenceIds, `${label}.evidenceIds`, 128),
  }));
}

function normalizePseudocode(values: readonly PseudocodeBlock[]): PseudocodeBlock[] {
  requireCount(values, "pseudocode", 1, 32);
  return normalizeIdentified(values, "pseudocode", (value, label) => Object.freeze({
    id: identifier(value.id, `${label}.id`),
    title: text(value.title, `${label}.title`, 1_000),
    inputs: normalizeTextList(value.inputs, `${label}.inputs`, 128),
    outputs: normalizeTextList(value.outputs, `${label}.outputs`, 128),
    steps: normalizeTextListRequired(value.steps, `${label}.steps`, 512),
  }));
}

function normalizeModelComponents(values: readonly ModelComponent[]): ModelComponent[] {
  requireCount(values, "modelStructure", 1, 128);
  return normalizeIdentified(values, "modelStructure", (value, label) => {
    if (!["input", "transform", "state", "objective", "output"].includes(value.kind)) {
      throw new TypeError(`${label}.kind is invalid.`);
    }
    return Object.freeze({
      id: identifier(value.id, `${label}.id`),
      name: text(value.name, `${label}.name`, 1_000),
      kind: value.kind,
      description: text(value.description, `${label}.description`, 8_000),
      inputs: normalizeIdentifiers(value.inputs, `${label}.inputs`, 128),
      outputs: normalizeIdentifiers(value.outputs, `${label}.outputs`, 128),
      parameters: normalizeTextList(value.parameters, `${label}.parameters`, 128),
      invariants: normalizeTextList(value.invariants, `${label}.invariants`, 128),
    });
  });
}

function normalizeProcedure(value: MethodProcedure, label: string): MethodProcedure {
  if (!value || !["required", "not_applicable"].includes(value.applicability)) throw new TypeError(`${label}.applicability is invalid.`);
  if (value.applicability === "required" && (!Array.isArray(value.steps) || value.steps.length === 0)) {
    throw new TypeError(`${label} requires at least one step.`);
  }
  if (value.applicability === "not_applicable" && value.rationale === undefined) {
    throw new TypeError(`${label} needs a rationale when it is not applicable.`);
  }
  const steps = normalizeIdentified(value.steps ?? [], `${label}.steps`, (step, itemLabel) => Object.freeze({
    id: identifier(step.id, `${itemLabel}.id`),
    action: text(step.action, `${itemLabel}.action`, 8_000),
    inputs: normalizeTextList(step.inputs, `${itemLabel}.inputs`, 128),
    outputs: normalizeTextList(step.outputs, `${itemLabel}.outputs`, 128),
    deterministic: boolean(step.deterministic, `${itemLabel}.deterministic`),
    ...(step.checkpoint === undefined ? {} : { checkpoint: text(step.checkpoint, `${itemLabel}.checkpoint`, 2_000) }),
  }));
  return Object.freeze({
    applicability: value.applicability,
    ...(value.rationale === undefined ? {} : { rationale: text(value.rationale, `${label}.rationale`, 8_000) }),
    steps,
  });
}

function normalizeComplexity(values: readonly ComplexityClaim[]): ComplexityClaim[] {
  requireCount(values, "complexity", 1, 64);
  return normalizeIdentified(values, "complexity", (value, label) => {
    if (!value.variables || typeof value.variables !== "object" || Array.isArray(value.variables)) {
      throw new TypeError(`${label}.variables must be an object.`);
    }
    const variables = Object.fromEntries(Object.entries(value.variables).map(([key, description]) => [
      identifier(key, `${label}.variables key`),
      text(description, `${label}.variables.${key}`, 2_000),
    ]));
    return Object.freeze({
      id: identifier(value.id, `${label}.id`),
      operation: text(value.operation, `${label}.operation`, 4_000),
      time: text(value.time, `${label}.time`, 1_000),
      space: text(value.space, `${label}.space`, 1_000),
      variables: Object.freeze(variables),
      conditions: normalizeTextList(value.conditions, `${label}.conditions`, 64),
    });
  });
}

function normalizeCounterexamples(values: readonly MethodCounterexample[], assumptionIds: ReadonlySet<string>): MethodCounterexample[] {
  requireCount(values, "counterexamples", 1, 128);
  return normalizeIdentified(values, "counterexamples", (value, label) => {
    const violated = normalizeIdentifiers(value.violatedAssumptionIds, `${label}.violatedAssumptionIds`, 64);
    for (const id of violated) if (!assumptionIds.has(id)) throw new TypeError(`${label} references unknown assumption ${id}.`);
    return Object.freeze({
      id: identifier(value.id, `${label}.id`),
      input: text(value.input, `${label}.input`, 8_000),
      violatedAssumptionIds: violated,
      expectedFailure: text(value.expectedFailure, `${label}.expectedFailure`, 8_000),
      detection: text(value.detection, `${label}.detection`, 8_000),
    });
  });
}

function normalizeFailureBoundaries(values: readonly MethodFailureBoundary[]): MethodFailureBoundary[] {
  requireCount(values, "failureBoundaries", 1, 128);
  return normalizeIdentified(values, "failureBoundaries", (value, label) => Object.freeze({
    id: identifier(value.id, `${label}.id`),
    condition: text(value.condition, `${label}.condition`, 8_000),
    consequence: text(value.consequence, `${label}.consequence`, 8_000),
    detection: text(value.detection, `${label}.detection`, 8_000),
    mitigation: text(value.mitigation, `${label}.mitigation`, 8_000),
    stopRule: text(value.stopRule, `${label}.stopRule`, 8_000),
  }));
}

function normalizeInterfaces(values: readonly ImplementationInterface[]): ImplementationInterface[] {
  requireCount(values, "interfaces", 1, 128);
  return normalizeIdentified(values, "interfaces", (value, label) => {
    if (!["function", "cli", "data"].includes(value.kind)) throw new TypeError(`${label}.kind is invalid.`);
    return Object.freeze({
      id: identifier(value.id, `${label}.id`),
      name: text(value.name, `${label}.name`, 1_000),
      kind: value.kind,
      signature: text(value.signature, `${label}.signature`, 8_000),
      inputs: normalizeTextList(value.inputs, `${label}.inputs`, 128),
      outputs: normalizeTextList(value.outputs, `${label}.outputs`, 128),
      errors: normalizeTextList(value.errors, `${label}.errors`, 128),
      sideEffects: normalizeTextList(value.sideEffects, `${label}.sideEffects`, 128),
    });
  });
}

function normalizeVerificationChecks(values: readonly VerificationCheckSpec[]): VerificationCheckSpec[] {
  requireCount(values, "verificationChecks", 1, 128);
  return normalizeIdentified(values, "verificationChecks", (value, label) => {
    if (!["unit", "numerical", "smoke"].includes(value.kind)) throw new TypeError(`${label}.kind is invalid.`);
    if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 3_600_000) throw new TypeError(`${label}.timeoutMs is invalid.`);
    if (!Number.isSafeInteger(value.expectedExitCode)) throw new TypeError(`${label}.expectedExitCode must be an integer.`);
    const numericalExpectations = (value.numericalExpectations ?? []).map((expectation, index) => {
      if (!Number.isFinite(expectation.expected) || !Number.isFinite(expectation.absoluteTolerance) || expectation.absoluteTolerance < 0) {
        throw new TypeError(`${label}.numericalExpectations[${index}] is invalid.`);
      }
      return Object.freeze({
        key: identifier(expectation.key, `${label}.numericalExpectations[${index}].key`),
        expected: expectation.expected,
        absoluteTolerance: expectation.absoluteTolerance,
      });
    });
    if (value.kind === "numerical" && numericalExpectations.length === 0) throw new TypeError(`${label} needs numerical expectations.`);
    return Object.freeze({
      id: identifier(value.id, `${label}.id`),
      kind: value.kind,
      command: text(value.command, `${label}.command`, 4_000),
      args: normalizeTextList(value.args, `${label}.args`, 128, true),
      timeoutMs: value.timeoutMs,
      expectedExitCode: value.expectedExitCode,
      stdoutIncludes: normalizeTextList(value.stdoutIncludes, `${label}.stdoutIncludes`, 128, true),
      numericalExpectations,
    });
  });
}

function normalizeRoutes(
  values: readonly ImplementationRoute[],
  interfaceIds: ReadonlySet<string>,
  verificationIds: ReadonlySet<string>,
): ImplementationRoute[] {
  requireCount(values, "implementationRoutes", 1, 16);
  return normalizeIdentified(values, "implementationRoutes", (value, label) => {
    if (!value.isolation || !["dedicated_workspace", "container", "remote"].includes(value.isolation.strategy)
      || value.isolation.requiresSeparateRoot !== true || value.isolation.mutatesUserWorktree !== false
      || !["disabled", "explicit"].includes(value.isolation.network)) {
      throw new TypeError(`${label}.isolation must preserve the user worktree and require a separate root.`);
    }
    const routeInterfaceIds = normalizeIdentifiers(value.interfaceIds, `${label}.interfaceIds`, 128);
    const routeVerificationIds = normalizeIdentifiers(value.verificationCheckIds, `${label}.verificationCheckIds`, 128);
    for (const id of routeInterfaceIds) if (!interfaceIds.has(id)) throw new TypeError(`${label} references unknown interface ${id}.`);
    for (const id of routeVerificationIds) if (!verificationIds.has(id)) throw new TypeError(`${label} references unknown verification check ${id}.`);
    const entrypoint = normalizeTextListRequired(value.entrypoint, `${label}.entrypoint`, 128, true);
    if (!entrypoint[0]?.trim()) throw new TypeError(`${label}.entrypoint must start with an executable.`);
    const sourceFiles = normalizePaths(value.sourceFiles, `${label}.sourceFiles`, true);
    const testFiles = normalizePaths(value.testFiles, `${label}.testFiles`, true);
    return Object.freeze({
      id: identifier(value.id, `${label}.id`),
      name: text(value.name, `${label}.name`, 1_000),
      runtime: text(value.runtime, `${label}.runtime`, 1_000),
      entrypoint,
      isolation: Object.freeze({ ...value.isolation }),
      sourceFiles,
      testFiles,
      interfaceIds: routeInterfaceIds,
      verificationCheckIds: routeVerificationIds,
    });
  });
}

function normalizeExpectedConclusions(values: readonly ExpectedConclusion[], checkIds: ReadonlySet<string>): ExpectedConclusion[] {
  requireCount(values, "expectedConclusions", 1, 128);
  return normalizeIdentified(values, "expectedConclusions", (value, label) => {
    const required = normalizeIdentifiers(value.requiredVerificationIds, `${label}.requiredVerificationIds`, 128);
    if (required.length === 0) throw new TypeError(`${label} must name at least one verification check.`);
    for (const id of required) if (!checkIds.has(id)) throw new TypeError(`${label} references unknown verification check ${id}.`);
    return Object.freeze({
      id: identifier(value.id, `${label}.id`),
      statement: text(value.statement, `${label}.statement`, 8_000),
      conditions: normalizeTextList(value.conditions, `${label}.conditions`, 128),
      requiredVerificationIds: required,
    });
  });
}

function normalizeIdentified<T, R extends { id: string }>(
  values: readonly T[],
  label: string,
  normalize: (value: T, label: string) => R,
): R[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  const ids = new Set<string>();
  return values.map((value, index) => {
    if (!value || typeof value !== "object") throw new TypeError(`${label}[${index}] must be an object.`);
    const normalized = normalize(value, `${label}[${index}]`);
    if (ids.has(normalized.id)) throw new TypeError(`${label} contains duplicate ID ${normalized.id}.`);
    ids.add(normalized.id);
    return normalized;
  });
}

function requireAllReferenced(label: string, expected: readonly string[], actual: readonly string[]): void {
  const referenced = new Set(actual);
  for (const id of expected) if (!referenced.has(id)) throw new TypeError(`Every ${label} must belong to an implementation route; missing ${id}.`);
}

function requireCount(values: readonly unknown[], label: string, minimum: number, maximum: number): void {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) {
    throw new TypeError(`${label} must contain between ${minimum} and ${maximum} entries.`);
  }
}

function normalizeIdentifiers(values: readonly string[], label: string, maximum: number): string[] {
  if (!Array.isArray(values) || values.length > maximum) throw new TypeError(`${label} must be a bounded array.`);
  const normalized = values.map((value, index) => identifier(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} must not contain duplicates.`);
  return normalized;
}

function normalizeTextList(
  values: readonly string[],
  label: string,
  maximum: number,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) throw new TypeError(`${label} must be a bounded array.`);
  return values.map((value, index) => allowEmpty
    ? boundedString(value, `${label}[${index}]`, 8_000)
    : text(value, `${label}[${index}]`, 8_000));
}

function normalizeTextListRequired(
  values: readonly string[],
  label: string,
  maximum: number,
  allowEmpty = false,
): string[] {
  const normalized = normalizeTextList(values, label, maximum, allowEmpty);
  if (normalized.length === 0) throw new TypeError(`${label} must not be empty.`);
  return normalized;
}

function normalizePaths(values: readonly string[], label: string, required: boolean): string[] {
  const paths = normalizeTextList(values, label, 512);
  if (required && paths.length === 0) throw new TypeError(`${label} must not be empty.`);
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)
      || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new TypeError(`${label} must contain safe relative paths.`);
    }
  }
  if (new Set(paths).size !== paths.length) throw new TypeError(`${label} must not contain duplicates.`);
  return paths;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || value.includes("\u0000")
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier.`);
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || value.includes("\u0000")) {
    throw new TypeError(`${label} must be bounded non-empty text.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\u0000")) {
    throw new TypeError(`${label} must be bounded text.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
}
