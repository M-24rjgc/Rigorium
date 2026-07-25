import { createResearchDesignPackage } from "../../../src/research/design/index.js";
import {
  createMethodSpecArtifact,
  type MethodSpecArtifact,
  type MethodSpecInput,
} from "../../../src/research/method/index.js";
import { researchDesignInput } from "../design/fixtures.js";

export function createReadyBrief() {
  const input = researchDesignInput();
  return createResearchDesignPackage({
    portfolio: {
      entry: input.entry,
      idea: input.idea,
      candidates: input.candidates,
      constraints: input.constraints,
      evidenceRequest: input.evidenceRequest,
      citations: input.citations,
    },
    challenge: {
      independentCriticisms: input.independentCriticisms,
      similarWorkRescans: input.similarWorkRescans,
      evidenceRescans: input.evidenceRescans,
    },
    comparison: { objectives: input.objectives, assessments: input.assessments },
    decision: { ...input.decision, eliminations: input.eliminations },
    brief: input.brief,
    now: new Date("2026-07-25T00:00:00.000Z"),
  }).researchBrief;
}

export function methodSpecInput(): MethodSpecInput {
  return {
    definitions: [{
      id: "definition-gate",
      symbol: "g(x)",
      domain: "Inputs x in R^d and gate values in [0, 1]",
      definition: "g(x) is the sample-conditioned interpolation weight.",
      units: "dimensionless",
    }],
    assumptions: [{
      id: "assumption-bounded-input",
      statement: "Input vectors have finite norm.",
      scope: "Training and held-out evaluation splits",
      justification: "The numerical implementation requires finite inputs.",
      falsifiable: true,
      evidenceIds: ["evidence-gap"],
    }],
    pseudocode: [{
      id: "algorithm-gate",
      title: "Adaptive aggregation",
      inputs: ["features", "base predictions"],
      outputs: ["aggregated prediction"],
      steps: ["Compute the gate.", "Interpolate the base predictions.", "Return the aggregate."],
    }],
    modelStructure: [{
      id: "component-gate",
      name: "Adaptive gate",
      kind: "transform",
      description: "Maps features to an interpolation weight.",
      inputs: ["features"],
      outputs: ["gate-value"],
      parameters: ["gate weights"],
      invariants: ["0 <= gate-value <= 1"],
    }],
    trainingProcedure: {
      applicability: "required",
      steps: [{
        id: "train-gate",
        action: "Minimize calibration loss over the training split.",
        inputs: ["training split"],
        outputs: ["gate weights"],
        deterministic: false,
        checkpoint: "Persist the seed and final weights.",
      }],
    },
    inferenceProcedure: {
      applicability: "required",
      steps: [{
        id: "infer-gate",
        action: "Apply the learned gate to base predictions.",
        inputs: ["features", "base predictions"],
        outputs: ["aggregated prediction"],
        deterministic: true,
      }],
    },
    complexity: [{
      id: "complexity-inference",
      operation: "Gate inference",
      time: "O(d)",
      space: "O(d)",
      variables: { d: "Feature dimension" },
      conditions: ["Dense feature representation"],
    }],
    counterexamples: [{
      id: "counterexample-nonfinite",
      input: "A feature vector containing NaN.",
      violatedAssumptionIds: ["assumption-bounded-input"],
      expectedFailure: "The gate value is not finite.",
      detection: "Reject non-finite features before inference.",
    }],
    failureBoundaries: [{
      id: "boundary-calibration",
      condition: "Calibration does not improve over the matched baseline.",
      consequence: "The mechanism claim is unsupported.",
      detection: "Run the numerical verification across held-out shifts.",
      mitigation: "Inspect the gate ablation and distribution coverage.",
      stopRule: "Stop after all declared seeds miss the threshold.",
    }],
    interfaces: [{
      id: "interface-cli",
      name: "Method evaluation CLI",
      kind: "cli",
      signature: "node src/model.js",
      inputs: ["configuration JSON"],
      outputs: ["metric JSON"],
      errors: ["invalid non-finite input"],
      sideEffects: ["stdout only"],
    }],
    verificationChecks: [
      {
        id: "check-unit",
        kind: "unit",
        command: process.execPath,
        args: ["-e", "process.stdout.write('unit-ok')"],
        timeoutMs: 10_000,
        expectedExitCode: 0,
        stdoutIncludes: ["unit-ok"],
        numericalExpectations: [],
      },
      {
        id: "check-numerical",
        kind: "numerical",
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({accuracy:0.91}))"],
        timeoutMs: 10_000,
        expectedExitCode: 0,
        stdoutIncludes: [],
        numericalExpectations: [{ key: "accuracy", expected: 0.9, absoluteTolerance: 0.02 }],
      },
      {
        id: "check-smoke",
        kind: "smoke",
        command: process.execPath,
        args: ["-e", "process.stdout.write('smoke-ok')"],
        timeoutMs: 10_000,
        expectedExitCode: 0,
        stdoutIncludes: ["smoke-ok"],
        numericalExpectations: [],
      },
    ],
    implementationRoutes: [{
      id: "route-node",
      name: "Isolated Node implementation",
      runtime: "Node.js",
      entrypoint: [process.execPath, "src/model.js"],
      isolation: {
        strategy: "dedicated_workspace",
        requiresSeparateRoot: true,
        mutatesUserWorktree: false,
        network: "disabled",
      },
      sourceFiles: ["src/model.js"],
      testFiles: ["tests/model.test.js"],
      interfaceIds: ["interface-cli"],
      verificationCheckIds: ["check-unit", "check-numerical", "check-smoke"],
    }],
    expectedConclusions: [{
      id: "expected-calibration",
      statement: "The isolated implementation satisfies its unit, numerical, and smoke contracts.",
      conditions: ["Declared fixture and tolerance"],
      requiredVerificationIds: ["check-unit", "check-numerical", "check-smoke"],
    }],
    nonGoals: ["No production deployment claim."],
    artifactId: "method-spec-main",
    now: new Date("2026-07-25T01:00:00.000Z"),
  };
}

export function createMethodSpecFixture(overrides: Partial<MethodSpecInput> = {}): MethodSpecArtifact {
  return createMethodSpecArtifact({
    brief: createReadyBrief(),
    spec: { ...methodSpecInput(), ...overrides },
  });
}
