import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ResearchDirectionLifecycleRepositoryError,
  getProjectResearchDirectionLifecyclePaths,
  loadProjectResearchDirectionLifecycle,
  updateProjectResearchDirectionLifecycle,
  type ResearchDirectionLifecycleUpdate,
} from "../../src/research/direction/directionLifecycle.js";
import type { DirectionAssessmentInput } from "../../src/research/direction/directionAssessment.js";
import type { ResearchDirectionSeedInput } from "../../src/research/direction/directionSeed.js";
import type { TitleConfirmationInput } from "../../src/research/direction/titleConfirmation.js";

const firstTime = new Date("2026-07-23T00:00:00.000Z");
const secondTime = new Date("2026-07-23T01:00:00.000Z");
const thirdTime = new Date("2026-07-23T02:00:00.000Z");

function seed(): ResearchDirectionSeedInput {
  return {
    cues: [
      { id: "interest", kind: "interest", text: "Reliable calibration for small models" },
      { id: "paper", kind: "paper", text: "Prior work reports calibration failures under shift", sourceReference: "doi:10.1000/prior" },
      { id: "data", kind: "data", text: "A labeled benchmark is available" },
      { id: "observation", kind: "experiment_observation", text: "Errors cluster after deployment shift" },
    ],
    terminology: [
      { id: "calibration", text: "calibration", cueIds: ["paper", "observation"], status: "observed" },
      { id: "shift", text: "distribution shift", cueIds: ["observation"], status: "observed" },
    ],
    constraints: [
      { id: "data-access", kind: "data", label: "Labeled benchmark access", status: "satisfied", cueIds: ["data"] },
      { id: "compute", kind: "compute", label: "Single-device budget", status: "satisfied", cueIds: ["interest"] },
      { id: "ethics", kind: "ethics", label: "Review of data handling", status: "satisfied", cueIds: ["data"] },
      { id: "baseline", kind: "baseline", label: "Reference calibration baseline", status: "satisfied", cueIds: ["paper"] },
      { id: "evaluation", kind: "evaluation", label: "Predeclared calibration evaluation", status: "satisfied", cueIds: ["observation"] },
    ],
    candidates: [{
      id: "calibration-under-shift",
      summary: "Evaluate calibration interventions for small models under distribution shift.",
      cueIds: ["interest", "paper", "observation"],
      terminologyIds: ["calibration", "shift"],
      constraintIds: ["data-access", "compute", "ethics", "baseline", "evaluation"],
      hypotheses: [{
        id: "calibration-effect",
        statement: "Calibration interventions change reliability under distribution shift.",
        cueIds: ["paper", "observation"],
        terminologyIds: ["calibration", "shift"],
        constraintIds: ["baseline", "evaluation"],
      }],
      contributions: [{
        id: "comparison-protocol",
        statement: "A bounded calibration comparison protocol for distribution shift.",
        cueIds: ["interest", "observation"],
        constraintIds: ["data-access", "evaluation"],
      }],
      titleSeed: "Evaluating calibration interventions under distribution shift",
    }],
  };
}

function assessment(): DirectionAssessmentInput {
  return {
    evidence: [
      {
        id: "prior-art",
        paperId: "doi:10.1000/prior",
        role: "prior_art",
        statement: "Prior work establishes the calibration-under-shift setting.",
        strength: "direct",
      },
      {
        id: "gap",
        paperId: "doi:10.1000/gap",
        role: "gap",
        statement: "The cited comparison leaves calibration interventions under shift incompletely evaluated.",
        strength: "direct",
      },
      {
        id: "ethics-evidence",
        paperId: "doi:10.1000/ethics",
        role: "ethics",
        statement: "The benchmark license permits the stated research use.",
        strength: "direct",
      },
    ],
    constraints: [
      { id: "data-access", kind: "data", label: "Labeled benchmark access", status: "satisfied" },
      { id: "compute", kind: "compute", label: "Single-device budget", status: "satisfied" },
      { id: "ethics", kind: "ethics", label: "Review of data handling", status: "satisfied", evidenceIds: ["ethics-evidence"] },
      { id: "baseline", kind: "baseline", label: "Reference calibration baseline", status: "satisfied" },
      { id: "evaluation", kind: "evaluation", label: "Predeclared calibration evaluation", status: "satisfied" },
    ],
    candidates: [{
      id: "calibration-under-shift",
      summary: "Evaluate calibration interventions for small models under distribution shift.",
      evidenceIds: ["prior-art", "gap"],
      constraintIds: ["data-access", "compute", "ethics", "baseline", "evaluation"],
      hypotheses: [{
        id: "calibration-effect",
        statement: "Calibration interventions change reliability under distribution shift.",
        failureCriterion: "The intervention does not improve the predeclared calibration metric over the reference baseline.",
        evidenceIds: ["prior-art", "gap"],
        evaluationConstraintId: "evaluation",
        baselineConstraintIds: ["baseline"],
      }],
    }],
  };
}

function title(confirmed = false): TitleConfirmationInput {
  return {
    directionId: "calibration-under-shift",
    candidateTitle: "Evaluating calibration interventions under distribution shift",
    confirmed,
    evidence: assessment().evidence!.slice(0, 2),
  };
}

async function projectRoot(label: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), `rigorium-direction-lifecycle-${label}-`));
}

function stageStatus(state: NonNullable<Awaited<ReturnType<typeof loadProjectResearchDirectionLifecycle>>>, id: string): string | undefined {
  return state.checklist.items.find((item) => item.id === id)?.status;
}

test("persists the full cue-to-provisional-title lifecycle without a Project rename", async () => {
  const root = await projectRoot("full");
  const paths = getProjectResearchDirectionLifecyclePaths({ projectRoot: root });

  const seeded = await updateProjectResearchDirectionLifecycle({
    projectRoot: root,
    update: { seed: seed() },
    now: firstTime,
  });
  assert.equal(seeded.created, true);
  assert.equal(seeded.persisted, true);
  assert.match(seeded.path, /\.rigorium[\\/]research[\\/]direction-lifecycle\.json$/u);
  assert.equal(stageStatus(seeded.state, "cue_classification"), "complete");
  assert.equal(stageStatus(seeded.state, "terminology"), "complete");
  assert.equal(stageStatus(seeded.state, "constraints"), "complete");
  assert.equal(stageStatus(seeded.state, "evidence_gap_analysis"), "needs_input");
  assert.equal(seeded.state.checklist.projectNameAction.status, "not_ready");
  assert.equal("projectName" in seeded.state, false);

  const assessed = await updateProjectResearchDirectionLifecycle({
    projectRoot: root,
    expectedRevision: seeded.state.revision,
    update: {
      assessment: assessment(),
      selectedDirectionId: "calibration-under-shift",
    },
    now: secondTime,
  });
  assert.equal(stageStatus(assessed.state, "evidence_gap_analysis"), "complete");
  assert.equal(stageStatus(assessed.state, "candidate_comparison"), "complete");
  assert.equal(stageStatus(assessed.state, "novelty_value_rescan"), "complete");
  assert.equal(stageStatus(assessed.state, "feasibility_ethics_evaluation"), "complete");
  assert.equal(stageStatus(assessed.state, "falsifiable_hypotheses_contributions"), "complete");
  assert.equal(stageStatus(assessed.state, "minimum_viability"), "complete");
  assert.equal(stageStatus(assessed.state, "provisional_title"), "needs_input");

  const pending = await updateProjectResearchDirectionLifecycle({
    projectRoot: root,
    expectedRevision: assessed.state.revision,
    update: { titleConfirmation: title(false) },
    now: thirdTime,
  });
  assert.equal(stageStatus(pending.state, "provisional_title"), "complete");
  assert.equal(stageStatus(pending.state, "project_name_confirmation"), "awaiting_confirmation");
  assert.equal(pending.state.checklist.status, "awaiting_title_confirmation");
  assert.equal(pending.state.checklist.projectNameAction.status, "not_ready");

  const confirmed = await updateProjectResearchDirectionLifecycle({
    projectRoot: root,
    expectedRevision: pending.state.revision,
    update: { titleConfirmation: title(true) },
    now: new Date("2026-07-23T03:00:00.000Z"),
  });
  assert.equal(stageStatus(confirmed.state, "project_name_confirmation"), "complete");
  assert.equal(confirmed.state.checklist.status, "ready_for_explicit_project_name_action");
  assert.equal(confirmed.state.checklist.projectNameAction.status, "ready_for_explicit_project_action");
  assert.equal(confirmed.state.checklist.projectNameAction.requiresExplicitUserAction, true);
  assert.equal(confirmed.state.checklist.projectNameAction.name, title(true).candidateTitle);
  assert.equal("projectName" in confirmed.state, false);

  const loaded = await loadProjectResearchDirectionLifecycle({ projectRoot: root });
  assert.deepEqual(loaded, confirmed.state);
  const serialized = await readFile(paths.lifecyclePath, "utf8");
  assert.match(serialized, /"research_direction_lifecycle"/u);
  assert.doesNotMatch(serialized, /"projectName"\s*:/u);
});

test("is idempotent, rejects stale revisions, and retains the prior lifecycle document", async () => {
  const root = await projectRoot("revision");
  const first = await updateProjectResearchDirectionLifecycle({
    projectRoot: root,
    update: { seed: seed() },
    now: firstTime,
  });
  const replay = await updateProjectResearchDirectionLifecycle({
    projectRoot: root,
    expectedRevision: first.state.revision,
    update: { seed: seed() },
    now: secondTime,
  });
  assert.equal(replay.persisted, false);
  assert.equal(replay.state.revision, first.state.revision);
  assert.equal(replay.state.updatedAt, first.state.updatedAt);

  const beforeConflict = await readFile(first.path, "utf8");
  await assert.rejects(
    updateProjectResearchDirectionLifecycle({
      projectRoot: root,
      expectedRevision: first.state.revision - 1,
      update: { selectedDirectionId: null },
      now: thirdTime,
    }),
    (error: unknown) => error instanceof ResearchDirectionLifecycleRepositoryError && error.code === "revision_conflict",
  );
  assert.equal(await readFile(first.path, "utf8"), beforeConflict);
});

test("fails closed for a title outside the selected evidence trace and for corrupt storage", async () => {
  const root = await projectRoot("validation");
  const seeded = await updateProjectResearchDirectionLifecycle({
    projectRoot: root,
    update: { seed: seed(), assessment: assessment(), selectedDirectionId: "calibration-under-shift" },
    now: firstTime,
  });
  const invalidTitle: ResearchDirectionLifecycleUpdate = {
    titleConfirmation: {
      ...title(),
      evidence: [{
        id: "outside-evidence",
        paperId: "doi:10.1000/outside",
        role: "gap",
        statement: "This evidence is not part of the assessment.",
      }],
    },
  };
  await assert.rejects(
    updateProjectResearchDirectionLifecycle({
      projectRoot: root,
      expectedRevision: seeded.state.revision,
      update: invalidTitle,
      now: secondTime,
    }),
    (error: unknown) => error instanceof ResearchDirectionLifecycleRepositoryError && error.code === "invalid_input",
  );

  await writeFile(seeded.path, "{not valid json", "utf8");
  await assert.rejects(
    loadProjectResearchDirectionLifecycle({ projectRoot: root }),
    (error: unknown) => error instanceof ResearchDirectionLifecycleRepositoryError && error.code === "corrupt_json",
  );
});

test("surfaces blocked ethics and evaluation constraints instead of treating viability as complete", async () => {
  const root = await projectRoot("blocked");
  const blockedAssessment = assessment();
  blockedAssessment.constraints = blockedAssessment.constraints!.map((constraint) => constraint.id === "ethics"
    ? { ...constraint, status: "blocked" as const, required: true }
    : constraint);

  const result = await updateProjectResearchDirectionLifecycle({
    projectRoot: root,
    update: {
      seed: seed(),
      assessment: blockedAssessment,
      selectedDirectionId: "calibration-under-shift",
    },
    now: firstTime,
  });
  assert.equal(stageStatus(result.state, "feasibility_ethics_evaluation"), "blocked");
  assert.equal(stageStatus(result.state, "minimum_viability"), "blocked");
  assert.equal(result.state.checklist.status, "blocked");
});
