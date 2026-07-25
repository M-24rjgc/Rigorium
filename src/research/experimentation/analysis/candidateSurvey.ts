export type ExperimentAnalysisCandidate = Readonly<{
  name: string;
  inspectedVersion: string;
  license: string;
  runtime: string;
  evidenceUrl: string;
  adoption: "numerical_cross_check" | "query_shape_reuse" | "excluded";
  reason: string;
}>;

/**
 * Evidence captured on 2026-07-25. Python packages were inspected and used
 * only for independent numerical checks; this module has no Python runtime
 * dependency and no package was installed by the survey.
 */
export const EXPERIMENT_ANALYSIS_CANDIDATE_SURVEY = Object.freeze({
  auditedAt: "2026-07-25",
  candidates: Object.freeze([
    {
      name: "SciPy",
      inspectedVersion: "1.16.3 (local)",
      license: "BSD-3-Clause",
      runtime: "Python 3.13.5; locally available, not invoked by Rigorium",
      evidenceUrl: "https://github.com/scipy/scipy",
      adoption: "numerical_cross_check",
      reason: "Its Student-t interval independently matched the TypeScript implementation for the audited small-sample fixture.",
    },
    {
      name: "statsmodels",
      inspectedVersion: "0.14.6 (local)",
      license: "BSD-3-Clause",
      runtime: "Python 3.13.5; locally available, not invoked by Rigorium",
      evidenceUrl: "https://github.com/statsmodels/statsmodels",
      adoption: "numerical_cross_check",
      reason: "Its DescrStatsW t interval matched SciPy and the TypeScript result; retaining it as a runtime dependency would add no capability here.",
    },
    {
      name: "MLflow",
      inspectedVersion: "c4a3fe486dcb574c782c4c3d5ff058f1baefe71a",
      license: "Apache-2.0; LICENSE sha256:6395355de6f391afff35996a30fb41b189b4991a4cb54993ace35ab69a0bfa28",
      runtime: "Not installed in the local Python environment",
      evidenceUrl: "https://github.com/mlflow/mlflow/tree/c4a3fe486dcb574c782c4c3d5ff058f1baefe71a",
      adoption: "query_shape_reuse",
      reason: "Reuse only the audited distinction between numeric metric comparisons, string metadata comparisons, aliases, and explicit ordering; no MLflow API or code is bundled.",
    },
    {
      name: "Optuna",
      inspectedVersion: "5893a4b410ba5d6b54964bb1091c252551042724",
      license: "MIT; LICENSE sha256:c3df8e8523cf46be4b366ee7dd11578454b10ea5ec5159e57df849513aafe059",
      runtime: "Not installed in the local Python environment",
      evidenceUrl: "https://github.com/optuna/optuna/tree/5893a4b410ba5d6b54964bb1091c252551042724",
      adoption: "excluded",
      reason: "An unavailable optimizer must not be presented as executable; bounded explicit grids cover deterministic next-trial proposals without predicted measurements.",
    },
  ] satisfies readonly ExperimentAnalysisCandidate[]),
  decision: Object.freeze({
    statistics: "Use a pure TypeScript deterministic core with SciPy and statsmodels retained only as independent audit evidence.",
    tracking: "Use immutable Rigorium run and metric envelopes; borrow only compatible MLflow query semantics.",
    optimization: "Use a bounded deterministic grid and label every suggestion proposed_not_executed; keep the Optuna adapter excluded until explicitly installed and approved.",
  }),
});
