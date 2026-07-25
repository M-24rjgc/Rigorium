import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import {
  getProjectResearchArtifactPaths,
} from "../../../src/research/artifacts/repository.js";
import {
  createResearchArtifact,
  toResearchArtifactRef,
  type ResearchArtifactEnvelope,
  type ResearchArtifactKind,
  type ResearchArtifactParent,
} from "../../../src/research/artifacts/types.js";
import {
  createResearchArtifactsTool,
} from "../../../src/tool/builtin/researchArtifacts.js";
import { PilotDeckToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const T0 = new Date("2026-07-25T12:00:00.000Z");
const T1 = new Date("2026-07-25T12:01:00.000Z");

test("research_artifacts persists envelopes across tool instances and keeps Projects isolated", async () => {
  const left = await projectRoot("artifact-runtime-left");
  const right = await projectRoot("artifact-runtime-right");
  const tool = createResearchArtifactsTool();
  const evidence = artifact("evidence_pack", "runtime-evidence", T0);
  const brief = artifact("research_brief", "runtime-brief", T0, [{
    relation: "uses",
    artifact: toResearchArtifactRef(evidence),
  }]);

  assert.equal(tool.isReadOnly({ operation: "list" }), true);
  assert.equal(tool.isConcurrencySafe({ operation: "history", artifactId: evidence.artifactId }), true);
  assert.equal(tool.isReadOnly({ operation: "append_batch", artifacts: [evidence] }), false);
  assert.equal(tool.isConcurrencySafe({ operation: "invalidate_descendants", roots: [toResearchArtifactRef(evidence)], reason: "manual" }), false);
  assert.equal(tool.isDestructive?.({ operation: "invalidate_descendants", roots: [toResearchArtifactRef(evidence)], reason: "manual" }), false);
  assert.equal(tool.requiresUserInteraction?.({ operation: "append_batch", artifacts: [evidence] }), false);
  assert.equal(tool.isOpenWorld?.({ operation: "append_batch", artifacts: [evidence] }), false);

  const appended = await tool.execute({
    operation: "append_batch",
    artifacts: [evidence, brief],
    expectedRepositoryRevision: 0,
  }, context(left, T0));
  assert.equal(appended.data?.projectRoot, left);
  assert.equal(appended.data?.persisted, true);
  assert.equal(appended.data?.repository?.revision, 1);
  assert.deepEqual(appended.data?.appendedRefs, [toResearchArtifactRef(evidence), toResearchArtifactRef(brief)]);

  const retried = await tool.execute({
    operation: "append_batch",
    artifacts: [brief, evidence],
    expectedRepositoryRevision: 1,
  }, context(left, T1));
  assert.equal(retried.data?.persisted, false);
  assert.equal(retried.data?.repository?.revision, 1);
  assert.deepEqual(retried.data?.idempotentRefs, [toResearchArtifactRef(evidence), toResearchArtifactRef(brief)]);

  const restartedTool = createResearchArtifactsTool();
  const loaded = await restartedTool.execute({ operation: "get", artifactId: evidence.artifactId, revision: 1 }, context(left, T1));
  assert.equal(loaded.data?.artifact?.contentHash, evidence.contentHash);
  assert.equal(loaded.data?.repository?.artifactCount, 2);

  const history = await restartedTool.execute({ operation: "history", artifactId: brief.artifactId }, context(left, T1));
  assert.deepEqual(history.data?.artifacts?.map((entry) => entry.artifactId), [brief.artifactId]);

  const invalidated = await restartedTool.execute({
    operation: "invalidate_descendants",
    roots: [toResearchArtifactRef(evidence)],
    reason: "manual",
    expectedRepositoryRevision: 1,
  }, context(left, T1));
  assert.equal(invalidated.data?.persisted, true);
  assert.equal(invalidated.data?.repository?.revision, 2);
  assert.deepEqual(invalidated.data?.staleRefs, [toResearchArtifactRef(brief)]);

  const latest = await restartedTool.execute({ operation: "latest", artifactId: brief.artifactId }, context(left, T1));
  assert.equal(latest.data?.artifact?.status, "stale");
  const stale = await restartedTool.execute({ operation: "list", kind: "research_brief", status: "stale" }, context(left, T1));
  assert.deepEqual(stale.data?.artifacts?.map((entry) => entry.artifactId), [brief.artifactId]);

  const isolated = await restartedTool.execute({ operation: "list" }, context(right, T1));
  assert.equal(isolated.data?.repository, null);
  assert.deepEqual(isolated.data?.artifacts, []);
});

test("research_artifacts rejects caller-supplied roots and malformed immutable envelopes", async () => {
  const root = await projectRoot("artifact-runtime-validation");
  const tool = createResearchArtifactsTool();
  const evidence = artifact("evidence_pack", "validation-evidence", T0);
  const rootValidation = await tool.validateInput!({ operation: "list", projectRoot: "D:\\outside" } as never, context(root, T0));
  assert.equal(rootValidation.ok, false);
  if (rootValidation.ok) assert.fail("Expected project root override to be rejected.");
  assert.match(rootValidation.issues[0]?.message ?? "", /fixed to the current cwd/u);

  const tampered = { ...evidence, payload: { value: "tampered" } } as ResearchArtifactEnvelope;
  const envelopeValidation = await tool.validateInput!({ operation: "append_batch", artifacts: [tampered] }, context(root, T0));
  assert.equal(envelopeValidation.ok, false);
  if (envelopeValidation.ok) assert.fail("Expected content-hash drift to be rejected.");
  assert.match(envelopeValidation.issues[0]?.message ?? "", /contentHash does not match/u);

  const nestedUnknown = {
    ...evidence,
    producer: { ...evidence.producer, unsupported: "field" },
  } as ResearchArtifactEnvelope;
  const nestedValidation = await tool.validateInput!({ operation: "append_batch", artifacts: [nestedUnknown] }, context(root, T0));
  assert.equal(nestedValidation.ok, false);
  if (nestedValidation.ok) assert.fail("Expected nested unknown envelope fields to be rejected.");
  assert.match(nestedValidation.issues[0]?.message ?? "", /unknown or non-canonical/u);

  await assert.rejects(
    tool.execute({ operation: "append_batch", artifacts: [tampered] }, context(root, T0)),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError
      && error.code === "invalid_tool_input"
      && /contentHash does not match/u.test(error.message),
  );
});

test("research_artifacts maps expected revisions and repository locks to file conflicts", async () => {
  const root = await projectRoot("artifact-runtime-conflicts");
  const tool = createResearchArtifactsTool();
  const first = artifact("evidence_pack", "conflict-evidence", T0);
  await tool.execute({ operation: "append_batch", artifacts: [first] }, context(root, T0));

  const conflictingRevision = artifact("finding", "conflict-finding", T1);
  await assert.rejects(
    tool.execute({
      operation: "append_batch",
      artifacts: [conflictingRevision],
      expectedRepositoryRevision: 0,
    }, context(root, T1)),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError
      && error.code === "file_conflict"
      && /Expected repository revision/u.test(error.message),
  );

  const paths = getProjectResearchArtifactPaths({ projectRoot: root });
  await writeFile(paths.lockPath, "active test lock\n", "utf8");
  const lockBlocked = artifact("finding", "lock-blocked-finding", T1);
  await assert.rejects(
    tool.execute({ operation: "append_batch", artifacts: [lockBlocked] }, context(root, T1)),
    (error: unknown) => {
      if (!(error instanceof PilotDeckToolRuntimeError) || error.code !== "file_conflict") return false;
      const diagnostic = error.details?.diagnostic;
      return typeof diagnostic === "object"
        && diagnostic !== null
        && (diagnostic as { code?: unknown }).code === "repository_busy";
    },
  );
});

function artifact(
  kind: ResearchArtifactKind,
  artifactId: string,
  now: Date,
  parents: readonly ResearchArtifactParent[] = [],
): ResearchArtifactEnvelope {
  return createResearchArtifact({
    kind,
    artifactId,
    producer: { kind: "tool", toolName: "research_artifacts_test" },
    parents,
    payload: { artifactId, value: "immutable test artifact" },
    now,
  });
}

function context(cwd: string, now: Date): PilotDeckToolRuntimeContext {
  return {
    sessionId: "research-artifacts-tool-test",
    turnId: `turn-${now.toISOString()}`,
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd }),
    now: () => now,
  };
}

async function projectRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `rigorium-${label}-`));
}
