import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_CANDIDATE_SURVEY } from "../../../src/research/review/candidateSurvey.js";

test("review candidate survey pins inspected sources and keeps unlicensed bundles pattern-only", () => {
  assert.equal(REVIEW_CANDIDATE_SURVEY.paperBench.commit, "51052cede8cc608f95bb00346635e03759013e5a");
  assert.deepEqual(REVIEW_CANDIDATE_SURVEY.paperBench.verifiedFixtureFields,
    ["id", "requirements", "weight", "sub_tasks", "task_category"]);
  assert.equal(REVIEW_CANDIDATE_SURVEY.neurips2025.bytes, 188273);
  assert.equal(REVIEW_CANDIDATE_SURVEY.neurips2025.licenseStatus, "no_distribution_license_declared");
  assert.equal(REVIEW_CANDIDATE_SURVEY.aclStyle.repositoryLicenseStatus, "no_root_license_declared");
  assert.equal(REVIEW_CANDIDATE_SURVEY.decisions.excludedComponents
    .some((entry) => entry.component.includes("source-file redistribution")), true);
});
