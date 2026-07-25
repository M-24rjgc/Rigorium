import type {
  ResearchArtifactEnvelope,
  ResearchArtifactRef,
} from "../artifacts/index.js";

export const RESEARCH_METHOD_SCHEMA_VERSION = 1 as const;

export type MathematicalDefinition = Readonly<{
  id: string;
  symbol: string;
  domain: string;
  definition: string;
  units?: string;
}>;

export type MethodAssumption = Readonly<{
  id: string;
  statement: string;
  scope: string;
  justification: string;
  falsifiable: boolean;
  evidenceIds: readonly string[];
}>;

export type PseudocodeBlock = Readonly<{
  id: string;
  title: string;
  inputs: readonly string[];
  outputs: readonly string[];
  steps: readonly string[];
}>;

export type ModelComponent = Readonly<{
  id: string;
  name: string;
  kind: "input" | "transform" | "state" | "objective" | "output";
  description: string;
  inputs: readonly string[];
  outputs: readonly string[];
  parameters: readonly string[];
  invariants: readonly string[];
}>;

export type ProcedureStep = Readonly<{
  id: string;
  action: string;
  inputs: readonly string[];
  outputs: readonly string[];
  deterministic: boolean;
  checkpoint?: string;
}>;

export type MethodProcedure = Readonly<{
  applicability: "required" | "not_applicable";
  rationale?: string;
  steps: readonly ProcedureStep[];
}>;

export type ComplexityClaim = Readonly<{
  id: string;
  operation: string;
  time: string;
  space: string;
  variables: Readonly<Record<string, string>>;
  conditions: readonly string[];
}>;

export type MethodCounterexample = Readonly<{
  id: string;
  input: string;
  violatedAssumptionIds: readonly string[];
  expectedFailure: string;
  detection: string;
}>;

export type MethodFailureBoundary = Readonly<{
  id: string;
  condition: string;
  consequence: string;
  detection: string;
  mitigation: string;
  stopRule: string;
}>;

export type ImplementationInterface = Readonly<{
  id: string;
  name: string;
  kind: "function" | "cli" | "data";
  signature: string;
  inputs: readonly string[];
  outputs: readonly string[];
  errors: readonly string[];
  sideEffects: readonly string[];
}>;

export type NumericalExpectation = Readonly<{
  key: string;
  expected: number;
  absoluteTolerance: number;
}>;

export type VerificationCheckSpec = Readonly<{
  id: string;
  kind: "unit" | "numerical" | "smoke";
  command: string;
  args: readonly string[];
  timeoutMs: number;
  expectedExitCode: number;
  stdoutIncludes: readonly string[];
  numericalExpectations: readonly NumericalExpectation[];
}>;

export type ImplementationRoute = Readonly<{
  id: string;
  name: string;
  runtime: string;
  entrypoint: readonly string[];
  isolation: Readonly<{
    strategy: "dedicated_workspace" | "container" | "remote";
    requiresSeparateRoot: true;
    mutatesUserWorktree: false;
    network: "disabled" | "explicit";
  }>;
  sourceFiles: readonly string[];
  testFiles: readonly string[];
  interfaceIds: readonly string[];
  verificationCheckIds: readonly string[];
}>;

export type ExpectedConclusion = Readonly<{
  id: string;
  statement: string;
  conditions: readonly string[];
  requiredVerificationIds: readonly string[];
}>;

export type MethodSpecPayload = Readonly<{
  schemaVersion: 1;
  kind: "method_spec";
  researchBriefRef: ResearchArtifactRef;
  researchQuestion: string;
  mechanism: string;
  definitions: readonly MathematicalDefinition[];
  assumptions: readonly MethodAssumption[];
  pseudocode: readonly PseudocodeBlock[];
  modelStructure: readonly ModelComponent[];
  trainingProcedure: MethodProcedure;
  inferenceProcedure: MethodProcedure;
  complexity: readonly ComplexityClaim[];
  counterexamples: readonly MethodCounterexample[];
  failureBoundaries: readonly MethodFailureBoundary[];
  interfaces: readonly ImplementationInterface[];
  implementationRoutes: readonly ImplementationRoute[];
  verificationChecks: readonly VerificationCheckSpec[];
  expectedConclusions: readonly ExpectedConclusion[];
  nonGoals: readonly string[];
  status: "executable";
}>;

export type MethodSpecArtifact = ResearchArtifactEnvelope<"method_spec", MethodSpecPayload>;

export type MethodSpecInput = Readonly<{
  definitions: readonly MathematicalDefinition[];
  assumptions: readonly MethodAssumption[];
  pseudocode: readonly PseudocodeBlock[];
  modelStructure: readonly ModelComponent[];
  trainingProcedure: MethodProcedure;
  inferenceProcedure: MethodProcedure;
  complexity: readonly ComplexityClaim[];
  counterexamples: readonly MethodCounterexample[];
  failureBoundaries: readonly MethodFailureBoundary[];
  interfaces: readonly ImplementationInterface[];
  implementationRoutes: readonly ImplementationRoute[];
  verificationChecks: readonly VerificationCheckSpec[];
  expectedConclusions: readonly ExpectedConclusion[];
  nonGoals?: readonly string[];
  artifactId?: string;
  revision?: number;
  now?: Date;
}>;

export type NumericalVerificationResult = Readonly<{
  key: string;
  expected: number;
  actual?: number;
  absoluteTolerance: number;
  passed: boolean;
}>;

export type VerificationRecord = Readonly<{
  id: string;
  checkId: string;
  kind: VerificationCheckSpec["kind"];
  status: "passed" | "failed" | "timeout" | "cancelled";
  command: readonly string[];
  exitCode: number | null;
  signal?: string;
  stdoutHash: string;
  stderrHash: string;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
  executedAt: string;
  workspaceMode: "isolated";
  numericalResults: readonly NumericalVerificationResult[];
  failureMessage?: string;
}>;

export type ObservedConclusion = Readonly<{
  id: string;
  expectedConclusionId?: string;
  statement: string;
  outcome: "supported" | "contradicted" | "inconclusive";
  verificationRecordIds: readonly string[];
}>;

export type ImplementationSnapshotFile = Readonly<{
  path: string;
  role: "source" | "test" | "config";
  sha256: string;
  bytes: number;
}>;

export type ImplementationSnapshotPayload = Readonly<{
  schemaVersion: 1;
  kind: "implementation_snapshot";
  methodSpecRef: ResearchArtifactRef;
  routeId: string;
  capturedAt: string;
  capturePolicy: Readonly<{
    readOnly: true;
    autoCommit: false;
    dirtyUserWorktree: "preserved";
  }>;
  files: readonly ImplementationSnapshotFile[];
  sourceHash: string;
  testHash: string;
  verificationRecords: readonly VerificationRecord[];
  expectedConclusions: readonly ExpectedConclusion[];
  observedConclusions: readonly ObservedConclusion[];
}>;

export type ImplementationSnapshotArtifact = ResearchArtifactEnvelope<
  "implementation_snapshot",
  ImplementationSnapshotPayload
>;

export type SnapshotFileInput = Readonly<{
  path: string;
  role: ImplementationSnapshotFile["role"];
}>;
