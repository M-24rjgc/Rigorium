import assert from "node:assert/strict";
import test from "node:test";
import {
  METHOD_IMPLEMENTATION_CANDIDATE_SURVEY,
  createMethodSpecArtifact,
  reviseMethodSpecArtifact,
} from "../../../src/research/method/index.js";
import { createReadyBrief, methodSpecInput } from "./fixtures.js";

test("a ready ResearchBrief becomes an executable, cross-referenced MethodSpec", () => {
  const brief = createReadyBrief();
  const artifact = createMethodSpecArtifact({ brief, spec: methodSpecInput() });

  assert.equal(artifact.kind, "method_spec");
  assert.equal(artifact.payload.status, "executable");
  assert.equal(artifact.payload.researchBriefRef.artifactId, brief.artifactId);
  assert.deepEqual(artifact.payload.implementationRoutes[0]?.isolation, {
    strategy: "dedicated_workspace",
    requiresSeparateRoot: true,
    mutatesUserWorktree: false,
    network: "disabled",
  });
  assert.equal(artifact.parents.some((parent) => parent.relation === "derived_from"
    && parent.artifact.artifactId === brief.artifactId), true);
});

test("an executable MethodSpec rejects missing definitions, counterexamples, routes, and checks", () => {
  const brief = createReadyBrief();
  const base = methodSpecInput();
  const invalid = [
    { label: "definitions", spec: { ...base, definitions: [] } },
    { label: "counterexamples", spec: { ...base, counterexamples: [] } },
    { label: "implementationRoutes", spec: { ...base, implementationRoutes: [] } },
    { label: "verificationChecks", spec: { ...base, verificationChecks: [] } },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => createMethodSpecArtifact({ brief, spec: candidate.spec }),
      new RegExp(candidate.label, "iu"),
    );
  }
});

test("route references are complete and cannot point at unknown interfaces or checks", () => {
  const brief = createReadyBrief();
  const base = methodSpecInput();
  const route = base.implementationRoutes[0]!;

  assert.throws(() => createMethodSpecArtifact({
    brief,
    spec: {
      ...base,
      implementationRoutes: [{ ...route, interfaceIds: ["interface-missing"] }],
    },
  }), /unknown interface interface-missing/iu);

  assert.throws(() => createMethodSpecArtifact({
    brief,
    spec: {
      ...base,
      implementationRoutes: [{
        ...route,
        verificationCheckIds: route.verificationCheckIds.filter((id) => id !== "check-smoke"),
      }],
    },
  }), /verification check.*check-smoke/iu);

  assert.throws(() => createMethodSpecArtifact({
    brief,
    spec: {
      ...base,
      implementationRoutes: [{ ...route, verificationCheckIds: ["check-missing"] }],
    },
  }), /unknown verification check check-missing/iu);

  assert.throws(() => createMethodSpecArtifact({
    brief,
    spec: {
      ...base,
      implementationRoutes: [{ ...route, entrypoint: [""] }],
    },
  }), /start with an executable/iu);
});

test("MethodSpec revisions retain identity and explicitly supersede the prior revision", () => {
  const brief = createReadyBrief();
  const first = createMethodSpecArtifact({ brief, spec: methodSpecInput() });
  const revisedInput = methodSpecInput();
  const second = reviseMethodSpecArtifact({
    previous: first,
    brief,
    spec: {
      ...revisedInput,
      nonGoals: [...(revisedInput.nonGoals ?? []), "No causal claim beyond the declared protocol."],
    },
  });

  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.revision, 2);
  assert.equal(second.parents.some((parent) => parent.relation === "supersedes"
    && parent.artifact.contentHash === first.contentHash), true);
  assert.notEqual(second.contentHash, first.contentHash);
});

test("candidate survey records inspected versions, licenses, reuse, and exclusions", () => {
  const survey = METHOD_IMPLEMENTATION_CANDIDATE_SURVEY;
  assert.deepEqual(
    Object.fromEntries(survey.localRuntime.packages.map((candidate) => [candidate.name, candidate.version])),
    {
      nbclient: "0.10.2",
      nbconvert: "7.16.6",
      nbformat: "5.10.4",
      pytest: "8.3.4",
      numpy: "2.1.3",
      sympy: "1.13.3",
    },
  );
  assert.equal(survey.paperBench.license, "MIT");
  assert.equal(survey.paperBench.adoption, "pattern_only");
  assert.equal(survey.decisions.excludedComponents.some((candidate) => candidate.component.includes("agent")), true);
  assert.equal(survey.decisions.excludedComponents.some((candidate) => candidate.component.includes("Docker")), true);
});
