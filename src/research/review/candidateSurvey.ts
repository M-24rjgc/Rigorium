export type ReviewCandidateSurvey = Readonly<{
  schemaVersion: 1;
  kind: "review_candidate_survey";
  surveyedAt: string;
  paperBench: Readonly<{
    repository: "openai/frontier-evals";
    commit: string;
    license: "MIT";
    licenseFile: "LICENSE.md";
    verifiedFixture: "project/paperbench/tests/unit/fixtures/rubrics/trivial.json";
    verifiedFixtureFields: readonly string[];
    adoption: "pattern_only";
  }>;
  neurips2025: Readonly<{
    officialBundle: string;
    bytes: 188273;
    contains: readonly ("sty" | "tex" | "pdf")[];
    checklistThemeCount: 16;
    licenseStatus: "no_distribution_license_declared";
    adoption: "rules_and_check_mechanisms_only";
  }>;
  aclStyle: Readonly<{
    repository: "acl-org/acl-style-files";
    commit: string;
    inspectedFiles: readonly ("acl.sty" | "acl_latex.tex")[];
    repositoryLicenseStatus: "no_root_license_declared";
    componentLicenseNote: "acl_natbib.bst_mentions_lppl";
    adoption: "behavioral_checks_only";
  }>;
  decisions: Readonly<{
    adoptedPatterns: readonly string[];
    excludedComponents: readonly Readonly<{ component: string; reason: string }>[];
  }>;
}>;

export const REVIEW_CANDIDATE_SURVEY: ReviewCandidateSurvey = Object.freeze({
  schemaVersion: 1 as const,
  kind: "review_candidate_survey" as const,
  surveyedAt: "2026-07-25",
  paperBench: Object.freeze({
    repository: "openai/frontier-evals" as const,
    commit: "51052cede8cc608f95bb00346635e03759013e5a",
    license: "MIT" as const,
    licenseFile: "LICENSE.md" as const,
    verifiedFixture: "project/paperbench/tests/unit/fixtures/rubrics/trivial.json" as const,
    verifiedFixtureFields: Object.freeze(["id", "requirements", "weight", "sub_tasks", "task_category"]),
    adoption: "pattern_only" as const,
  }),
  neurips2025: Object.freeze({
    officialBundle: "https://media.neurips.cc/Conferences/NeurIPS2025/Styles.zip",
    bytes: 188273 as const,
    contains: Object.freeze(["sty", "tex", "pdf"] as const),
    checklistThemeCount: 16 as const,
    licenseStatus: "no_distribution_license_declared" as const,
    adoption: "rules_and_check_mechanisms_only" as const,
  }),
  aclStyle: Object.freeze({
    repository: "acl-org/acl-style-files" as const,
    commit: "d5adc823ff0f80f98c80405ca0ab66c68e684409",
    inspectedFiles: Object.freeze(["acl.sty", "acl_latex.tex"] as const),
    repositoryLicenseStatus: "no_root_license_declared" as const,
    componentLicenseNote: "acl_natbib.bst_mentions_lppl" as const,
    adoption: "behavioral_checks_only" as const,
  }),
  decisions: Object.freeze({
    adoptedPatterns: Object.freeze([
      "Hierarchical review criteria decompose into anchored, inspectable findings.",
      "Compile, citation, page-limit, anonymity, and provenance checks run deterministically before synthesis.",
      "Independent review lanes preserve disagreements for explicit adjudication.",
    ]),
    excludedComponents: Object.freeze([
      Object.freeze({
        component: "PaperBench agent, judge, Docker, and control-plane stack",
        reason: "Rigorium already owns agent execution, artifact provenance, and project workflow boundaries.",
      }),
      Object.freeze({
        component: "NeurIPS and ACL source-file redistribution",
        reason: "The inspected official bundles do not declare a repository-wide distribution license suitable for copying.",
      }),
      Object.freeze({
        component: "Unanchored aggregate review scores",
        reason: "Revision decisions must remain traceable to manuscript locations and affected artifact references.",
      }),
    ]),
  }),
});
