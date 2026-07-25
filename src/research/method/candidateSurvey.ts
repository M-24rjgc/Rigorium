export type MethodCandidateSurveyPackage = Readonly<{
  name: string;
  version: string;
  license: "MIT" | "BSD-3-Clause";
  role: "notebook_execution" | "notebook_conversion" | "notebook_format" | "unit_verification" | "numerical_verification";
}>;

export type MethodImplementationCandidateSurvey = Readonly<{
  schemaVersion: 1;
  kind: "method_implementation_candidate_survey";
  surveyedAt: string;
  paperBench: Readonly<{
    repository: "openai/frontier-evals";
    projectPath: "project/paperbench";
    license: "MIT";
    archived: false;
    verifiedFixture: "tests/unit/fixtures/rubrics/trivial.json";
    adoption: "pattern_only";
    adoptedPatterns: readonly string[];
  }>;
  localRuntime: Readonly<{
    probes: readonly Readonly<{
      command: readonly string[];
      outcome: "passed";
    }>[];
    packages: readonly MethodCandidateSurveyPackage[];
  }>;
  decisions: Readonly<{
    directRouteComponents: readonly string[];
    excludedComponents: readonly Readonly<{
      component: string;
      reason: string;
    }>[];
  }>;
}>;

export const METHOD_IMPLEMENTATION_CANDIDATE_SURVEY: MethodImplementationCandidateSurvey = Object.freeze({
  schemaVersion: 1 as const,
  kind: "method_implementation_candidate_survey" as const,
  surveyedAt: "2026-07-25",
  paperBench: Object.freeze({
    repository: "openai/frontier-evals" as const,
    projectPath: "project/paperbench" as const,
    license: "MIT" as const,
    archived: false as const,
    verifiedFixture: "tests/unit/fixtures/rubrics/trivial.json" as const,
    adoption: "pattern_only" as const,
    adoptedPatterns: Object.freeze([
      "Hierarchical acceptance criteria keep broad claims traceable to small checks.",
      "Rubric fixtures make evaluation contracts inspectable before execution.",
    ]),
  }),
  localRuntime: Object.freeze({
    probes: Object.freeze([
      Object.freeze({ command: Object.freeze(["jupyter", "--version"]), outcome: "passed" as const }),
      Object.freeze({ command: Object.freeze(["jupyter", "nbconvert", "--version"]), outcome: "passed" as const }),
      Object.freeze({ command: Object.freeze(["pytest", "--version"]), outcome: "passed" as const }),
      Object.freeze({ command: Object.freeze(["python", "-c", "import nbclient, nbconvert, nbformat, pytest, numpy, sympy"]), outcome: "passed" as const }),
    ]),
    packages: Object.freeze([
      Object.freeze({ name: "nbclient", version: "0.10.2", license: "BSD-3-Clause" as const, role: "notebook_execution" as const }),
      Object.freeze({ name: "nbconvert", version: "7.16.6", license: "BSD-3-Clause" as const, role: "notebook_conversion" as const }),
      Object.freeze({ name: "nbformat", version: "5.10.4", license: "BSD-3-Clause" as const, role: "notebook_format" as const }),
      Object.freeze({ name: "pytest", version: "8.3.4", license: "MIT" as const, role: "unit_verification" as const }),
      Object.freeze({ name: "numpy", version: "2.1.3", license: "BSD-3-Clause" as const, role: "numerical_verification" as const }),
      Object.freeze({ name: "sympy", version: "1.13.3", license: "BSD-3-Clause" as const, role: "numerical_verification" as const }),
    ]),
  }),
  decisions: Object.freeze({
    directRouteComponents: Object.freeze([
      "nbclient for isolated notebook execution",
      "pytest for small unit checks",
      "NumPy and SymPy for numerical and symbolic checks",
    ]),
    excludedComponents: Object.freeze([
      Object.freeze({
        component: "PaperBench agent and judge orchestration",
        reason: "PilotDeck already owns agent execution and research artifact provenance.",
      }),
      Object.freeze({
        component: "PaperBench Docker execution layer",
        reason: "The first local method route uses an explicitly separate workspace without imposing a container dependency.",
      }),
      Object.freeze({
        component: "A second workflow control plane",
        reason: "Method implementation remains a project capability, not an independent stage controller.",
      }),
    ]),
  }),
});
