import type {
  ResearchDirectionAssessmentArtifact,
  ResearchDirectionLifecycleArtifact,
  ResearchDirectionSeedArtifact,
  ResearchTitleConfirmationArtifact,
} from './types';
import { RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS } from './types';

export const directionSeedArtifact: ResearchDirectionSeedArtifact = {
  schemaVersion: 1,
  kind: 'research_direction_seed',
  artifactId: 'direction-seed-fixture',
  createdAt: '2026-07-23T00:00:00.000Z',
  input: {
    cues: [{ id: 'interest', kind: 'interest', text: 'Reliable calibration under shift' }],
    terminology: [{ id: 'calibration', text: 'calibration', cueIds: ['interest'], status: 'observed' }],
    constraints: [{
      id: 'evaluation',
      kind: 'evaluation',
      label: 'Predeclared calibration metric',
      status: 'satisfied',
      cueIds: ['interest'],
    }],
    candidates: [{
      id: 'calibration-under-shift',
      summary: 'Evaluate calibration interventions under distribution shift.',
      cueIds: ['interest'],
      terminologyIds: ['calibration'],
      constraintIds: ['evaluation'],
      hypotheses: [{
        id: 'calibration-effect',
        statement: 'The intervention changes calibration under shift.',
        cueIds: ['interest'],
        terminologyIds: ['calibration'],
        constraintIds: ['evaluation'],
      }],
      contributions: [{
        id: 'comparison-protocol',
        statement: 'A bounded comparison protocol for shifted calibration.',
        cueIds: ['interest'],
        constraintIds: ['evaluation'],
      }],
      titleSeed: 'Evaluating calibration interventions under distribution shift',
    }],
  },
  result: {
    cues: [{ id: 'interest', kind: 'interest', text: 'Reliable calibration under shift' }],
    terminology: [{ id: 'calibration', text: 'calibration', cueIds: ['interest'], status: 'observed' }],
    constraints: [{
      id: 'evaluation',
      kind: 'evaluation',
      label: 'Predeclared calibration metric',
      status: 'satisfied',
      cueIds: ['interest'],
    }],
    constraintCoverage: {
      status: 'specified',
      suppliedConstraintIds: ['evaluation'],
      unresolvedConstraintIds: [],
    },
    candidateDirections: [{
      id: 'calibration-under-shift',
      summary: 'Evaluate calibration interventions under distribution shift.',
      cueIds: ['interest'],
      terminologyIds: ['calibration'],
      constraintIds: ['evaluation'],
      hypotheses: [{
        id: 'calibration-effect',
        statement: 'The intervention changes calibration under shift.',
        cueIds: ['interest'],
        terminologyIds: ['calibration'],
        constraintIds: ['evaluation'],
      }],
      contributions: [{
        id: 'comparison-protocol',
        statement: 'A bounded comparison protocol for shifted calibration.',
        cueIds: ['interest'],
        constraintIds: ['evaluation'],
      }],
      provisionalTitle: {
        status: 'proposed',
        text: 'Evaluating calibration interventions under distribution shift',
        origin: 'agent_seed',
        reasonCodes: ['provisional'],
        confirmation: {
          status: 'pending',
          confirmed: false,
          requiresExplicitUserAction: true,
          projectNameUpdate: { status: 'not_ready', requiresExplicitUserAction: true },
        },
      },
    }],
  },
  presentation: { autoOpen: true },
};

const evidence = [{
  id: 'gap-evidence',
  paperId: 'doi:10.1000/gap',
  role: 'gap' as const,
  statement: 'Prior work leaves the shifted calibration comparison incomplete.',
  strength: 'direct' as const,
}];

const trace = {
  evidenceIds: ['gap-evidence'],
  paperIds: ['doi:10.1000/gap'],
  constraintIds: ['evaluation'],
};

export const directionAssessmentArtifact: ResearchDirectionAssessmentArtifact = {
  schemaVersion: 1,
  kind: 'direction_assessment',
  artifactId: 'direction-assessment-fixture',
  createdAt: '2026-07-23T01:00:00.000Z',
  input: {
    evidence,
    constraints: [{
      id: 'evaluation',
      kind: 'evaluation',
      label: 'Predeclared calibration metric',
      status: 'satisfied',
      evidenceIds: ['gap-evidence'],
    }],
    candidates: [{
      id: 'calibration-under-shift',
      summary: 'Evaluate calibration interventions under distribution shift.',
      titleSeed: 'Evaluating calibration interventions under distribution shift',
      evidenceIds: ['gap-evidence'],
      constraintIds: ['evaluation'],
      hypotheses: [{
        id: 'calibration-effect',
        statement: 'The intervention changes calibration under shift.',
        failureCriterion: 'The predeclared calibration metric does not improve.',
        evidenceIds: ['gap-evidence'],
        evaluationConstraintId: 'evaluation',
        baselineConstraintIds: ['evaluation'],
      }],
    }],
  },
  result: {
    limits: { maxCandidates: 24 },
    rankedDirectionIds: ['calibration-under-shift'],
    assessments: [{
      rank: 1,
      directionId: 'calibration-under-shift',
      summary: 'Evaluate calibration interventions under distribution shift.',
      score: {
        ...trace,
        total: 19,
        evidence: 5,
        feasibility: 5,
        testability: 5,
        gapOpportunity: 4,
        caveatPenalty: 0,
        blockerPenalty: 0,
      },
      novelty: { ...trace, status: 'gap_evidenced' },
      caveats: [],
      falsifiableHypotheses: [{
        ...trace,
        id: 'calibration-effect',
        statement: 'The intervention changes calibration under shift.',
        failureCriterion: 'The predeclared calibration metric does not improve.',
        status: 'ready',
      }],
      targetConferences: [],
      unmetEvidenceGaps: [],
      minimumViability: { status: 'viable', reasons: [] },
      provisionalTitle: {
        ...trace,
        status: 'accepted',
        text: 'Evaluating calibration interventions under distribution shift',
        reasonCodes: ['provisional'],
      },
      conclusions: [],
    }],
  },
  presentation: { autoOpen: true },
};

export const titleConfirmationArtifact: ResearchTitleConfirmationArtifact = {
  schemaVersion: 1,
  kind: 'research_title_confirmation',
  artifactId: 'title-confirmation-fixture',
  createdAt: '2026-07-23T02:00:00.000Z',
  input: {
    directionId: 'calibration-under-shift',
    candidateTitle: 'Evaluating calibration interventions under distribution shift',
    evidence,
    confirmed: true,
  },
  result: {
    directionId: 'calibration-under-shift',
    title: {
      ...trace,
      status: 'accepted',
      text: 'Evaluating calibration interventions under distribution shift',
      reasonCodes: ['provisional'],
    },
    confirmation: {
      status: 'confirmed',
      confirmed: true,
      projectNameUpdate: {
        status: 'ready_for_explicit_project_action',
        name: 'Evaluating calibration interventions under distribution shift',
        requiresExplicitUserAction: true,
      },
    },
  },
  presentation: { autoOpen: true },
};

export const directionLifecycleArtifact: ResearchDirectionLifecycleArtifact = {
  schemaVersion: 1,
  kind: 'research_direction_lifecycle',
  artifactId: 'direction-lifecycle-fixture',
  createdAt: '2026-07-23T03:00:00.000Z',
  operation: 'saved',
  path: 'D:/project/.pilotdeck/research/direction-lifecycle.json',
  created: false,
  persisted: true,
  state: {
    schemaVersion: 1,
    kind: 'research_direction_lifecycle',
    revision: 4,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T03:00:00.000Z',
    seedInput: directionSeedArtifact.input,
    seed: directionSeedArtifact.result,
    assessment: {
      input: directionAssessmentArtifact.input,
      result: directionAssessmentArtifact.result,
    },
    selectedDirectionId: 'calibration-under-shift',
    titleConfirmation: {
      input: titleConfirmationArtifact.input,
      result: titleConfirmationArtifact.result,
    },
    checklist: {
      items: RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS.map((id) => ({
        id,
        status: 'complete' as const,
        candidateId: 'calibration-under-shift',
        evidenceIds: ['gap-evidence'],
        constraintIds: ['evaluation'],
        reasonCodes: [],
      })),
      completedStageIds: [...RESEARCH_DIRECTION_LIFECYCLE_STAGE_IDS],
      status: 'ready_for_explicit_project_name_action',
      projectNameAction: {
        status: 'ready_for_explicit_project_action',
        name: 'Evaluating calibration interventions under distribution shift',
        requiresExplicitUserAction: true,
      },
    },
  },
  presentation: { autoOpen: true },
};
