import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResearchArtifactGraph,
  createResearchArtifact,
  hashResearchArtifactContent,
  invalidateResearchArtifactDescendants,
  latestResearchArtifactRevisions,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
} from "../../src/research/artifacts/index.js";

const producer = { kind: "agent" as const, id: "research-agent" };

test("research artifact hashes are stable across object key ordering", () => {
  assert.equal(
    hashResearchArtifactContent({ beta: [2, 3], alpha: { z: true, a: "value" } }),
    hashResearchArtifactContent({ alpha: { a: "value", z: true }, beta: [2, 3] }),
  );
});

test("research artifact graph records missing parents without manufacturing them", () => {
  const evidence = createResearchArtifact({
    kind: "evidence_pack",
    payload: { papers: ["paper-1"] },
    producer,
    artifactId: "evidence-main",
    now: new Date("2026-07-25T00:00:00.000Z"),
  });
  const missing = { ...toResearchArtifactRef(evidence), artifactId: "evidence-missing" };
  const brief = createResearchArtifact({
    kind: "research_brief",
    payload: { question: "Can the mechanism be falsified?" },
    producer,
    artifactId: "brief-main",
    parents: [{ relation: "uses", artifact: missing }],
    now: new Date("2026-07-25T00:01:00.000Z"),
  });

  const graph = buildResearchArtifactGraph([evidence, brief]);
  assert.deepEqual(graph.roots, ["evidence-main@1"]);
  assert.deepEqual(graph.missingParents.map((entry) => entry.artifactId), ["evidence-missing"]);
});

test("upstream changes stale only transitive active descendants", () => {
  const evidence = createResearchArtifact({
    kind: "evidence_pack",
    payload: { papers: ["paper-1"] },
    producer,
    artifactId: "evidence-main",
    now: new Date("2026-07-25T00:00:00.000Z"),
  });
  const brief = createResearchArtifact({
    kind: "research_brief",
    payload: { question: "Question" },
    producer,
    artifactId: "brief-main",
    parents: [{ relation: "uses", artifact: toResearchArtifactRef(evidence) }],
    now: new Date("2026-07-25T00:01:00.000Z"),
  });
  const experiment = createResearchArtifact({
    kind: "experiment_spec",
    payload: { command: ["python", "train.py"] },
    producer,
    artifactId: "experiment-main",
    parents: [{ relation: "derived_from", artifact: toResearchArtifactRef(brief) }],
    now: new Date("2026-07-25T00:02:00.000Z"),
  });
  const unrelated = createResearchArtifact({
    kind: "citation_set",
    payload: { keys: [] },
    producer,
    artifactId: "citations",
    now: new Date("2026-07-25T00:03:00.000Z"),
  });

  const updated = invalidateResearchArtifactDescendants({
    artifacts: [evidence, brief, experiment, unrelated],
    roots: [toResearchArtifactRef(evidence)],
    reason: "upstream_changed",
    now: new Date("2026-07-25T01:00:00.000Z"),
  });
  const status = Object.fromEntries(updated.map((artifact) => [artifact.artifactId, artifact.status]));
  assert.deepEqual(status, {
    "evidence-main": "active",
    "brief-main": "stale",
    "experiment-main": "stale",
    citations: "active",
  });
});

test("research artifact graph rejects cycles and latest projection is deterministic", () => {
  const first = createResearchArtifact({
    kind: "research_brief",
    payload: { version: 1 },
    producer,
    artifactId: "brief",
    revision: 1,
    now: new Date("2026-07-25T00:00:00.000Z"),
  });
  const second = createResearchArtifact({
    kind: "research_brief",
    payload: { version: 2 },
    producer,
    artifactId: "brief",
    revision: 2,
    now: new Date("2026-07-25T00:01:00.000Z"),
  });
  assert.deepEqual(latestResearchArtifactRevisions([second, first]).map((entry) => entry.revision), [2]);

  const left = {
    ...first,
    artifactId: "left",
    parents: [{ relation: "uses" as const, artifact: { ...toResearchArtifactRef(second), artifactId: "right" } }],
  } as ResearchArtifactEnvelope;
  const right = {
    ...second,
    artifactId: "right",
    parents: [{ relation: "uses" as const, artifact: { ...toResearchArtifactRef(first), artifactId: "left" } }],
  } as ResearchArtifactEnvelope;
  assert.throws(() => buildResearchArtifactGraph([left, right]), /cycle/u);
});
