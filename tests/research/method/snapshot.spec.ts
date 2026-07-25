import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createImplementationSnapshotArtifact,
  runVerificationCheck,
  type MethodSpecArtifact,
  type VerificationRecord,
} from "../../../src/research/method/index.js";
import { createMethodSpecFixture, methodSpecInput } from "./fixtures.js";

async function implementationRoots(label: string): Promise<{
  projectRoot: string;
  implementationRoot: string;
  outsideRoot: string;
}> {
  const base = await mkdtemp(join(tmpdir(), `rigorium-method-snapshot-${label}-`));
  const projectRoot = join(base, "user-project");
  const implementationRoot = join(base, "isolated-implementation");
  const outsideRoot = join(base, "outside");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(join(implementationRoot, "src"), { recursive: true }),
    mkdir(join(implementationRoot, "tests"), { recursive: true }),
    mkdir(outsideRoot),
  ]);
  await Promise.all([
    writeFile(join(implementationRoot, "src", "model.js"), "export const score = 0.91;\n", "utf8"),
    writeFile(join(implementationRoot, "tests", "model.test.js"), "// isolated method test\n", "utf8"),
    writeFile(join(implementationRoot, "method.config.json"), "{\"seed\":7}\n", "utf8"),
  ]);
  return { projectRoot, implementationRoot, outsideRoot };
}

async function runRouteChecks(
  methodSpec: MethodSpecArtifact,
  roots: { projectRoot: string; implementationRoot: string },
): Promise<VerificationRecord[]> {
  return Promise.all(methodSpec.payload.verificationChecks.map((check, index) => runVerificationCheck({
    projectRoot: roots.projectRoot,
    workspaceRoot: roots.implementationRoot,
    check,
    recordId: `snapshot-record-${index}`,
    now: new Date("2026-07-25T03:00:00.000Z"),
  })));
}

test("snapshot hashes source, test, and config files while keeping expected and observed conclusions separate", async () => {
  const roots = await implementationRoots("complete");
  const methodSpec = createMethodSpecFixture();
  const verificationRecords = await runRouteChecks(methodSpec, roots);
  const observedConclusions = [{
    id: "observed-calibration",
    expectedConclusionId: "expected-calibration",
    statement: "All declared checks passed in the isolated implementation workspace.",
    outcome: "supported" as const,
    verificationRecordIds: verificationRecords.map((record) => record.id),
  }];
  const snapshot = await createImplementationSnapshotArtifact({
    methodSpec,
    routeId: "route-node",
    implementationRoot: roots.implementationRoot,
    configFiles: ["method.config.json"],
    verificationRecords,
    observedConclusions,
    now: new Date("2026-07-25T03:01:00.000Z"),
  });

  assert.equal(snapshot.kind, "implementation_snapshot");
  assert.equal(snapshot.payload.methodSpecRef.contentHash, methodSpec.contentHash);
  assert.deepEqual(snapshot.payload.capturePolicy, {
    readOnly: true,
    autoCommit: false,
    dirtyUserWorktree: "preserved",
  });
  assert.deepEqual(snapshot.payload.files.map((file) => [file.role, file.path]), [
    ["config", "method.config.json"],
    ["source", "src/model.js"],
    ["test", "tests/model.test.js"],
  ]);
  assert.equal(snapshot.payload.files.every((file) => /^sha256:[a-f0-9]{64}$/u.test(file.sha256)), true);
  assert.match(snapshot.payload.sourceHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(snapshot.payload.testHash, /^sha256:[a-f0-9]{64}$/u);
  assert.notStrictEqual(snapshot.payload.expectedConclusions, snapshot.payload.observedConclusions);
  assert.equal(snapshot.payload.expectedConclusions[0]?.id, "expected-calibration");
  assert.equal(snapshot.payload.observedConclusions[0]?.id, "observed-calibration");
});

test("aggregate hashes are stable and only the affected aggregate changes with content", async () => {
  const roots = await implementationRoots("stable-hash");
  const methodSpec = createMethodSpecFixture();
  const capture = () => createImplementationSnapshotArtifact({
    methodSpec,
    routeId: "route-node",
    implementationRoot: roots.implementationRoot,
    configFiles: ["method.config.json"],
  });
  const first = await capture();
  const second = await capture();
  assert.equal(first.payload.sourceHash, second.payload.sourceHash);
  assert.equal(first.payload.testHash, second.payload.testHash);

  await writeFile(join(roots.implementationRoot, "src", "model.js"), "export const score = 0.93;\n", "utf8");
  const changed = await capture();
  assert.notEqual(first.payload.sourceHash, changed.payload.sourceHash);
  assert.equal(first.payload.testHash, changed.payload.testHash);
});

test("snapshot rejects absolute paths, path escapes, symbolic links, and non-regular files", async () => {
  const roots = await implementationRoots("unsafe-paths");
  const methodSpec = createMethodSpecFixture();
  await assert.rejects(createImplementationSnapshotArtifact({
    methodSpec,
    routeId: "route-node",
    implementationRoot: roots.implementationRoot,
    configFiles: [join(roots.implementationRoot, "method.config.json")],
  }), /safe relative path/iu);
  await assert.rejects(createImplementationSnapshotArtifact({
    methodSpec,
    routeId: "route-node",
    implementationRoot: roots.implementationRoot,
    configFiles: ["../outside.json"],
  }), /safe relative path/iu);

  await mkdir(join(roots.implementationRoot, "config-directory"));
  await assert.rejects(createImplementationSnapshotArtifact({
    methodSpec,
    routeId: "route-node",
    implementationRoot: roots.implementationRoot,
    configFiles: ["config-directory"],
  }), /regular file/iu);

  await writeFile(join(roots.outsideRoot, "model.js"), "export const escaped = true;\n", "utf8");
  await symlink(
    roots.outsideRoot,
    join(roots.implementationRoot, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const base = methodSpecInput();
  const route = base.implementationRoutes[0]!;
  const linkedMethodSpec = createMethodSpecFixture({
    implementationRoutes: [{ ...route, sourceFiles: ["linked/model.js"] }],
  });
  await assert.rejects(createImplementationSnapshotArtifact({
    methodSpec: linkedMethodSpec,
    routeId: "route-node",
    implementationRoot: roots.implementationRoot,
  }), /symbolic link/iu);
});

test("observed conclusions can cite only supplied route verification records", async () => {
  const roots = await implementationRoots("observations");
  const methodSpec = createMethodSpecFixture();
  const verificationRecords = await runRouteChecks(methodSpec, roots);
  await assert.rejects(createImplementationSnapshotArtifact({
    methodSpec,
    routeId: "route-node",
    implementationRoot: roots.implementationRoot,
    verificationRecords,
    observedConclusions: [{
      id: "observed-unknown",
      expectedConclusionId: "expected-calibration",
      statement: "This conclusion cites evidence that was not captured.",
      outcome: "supported",
      verificationRecordIds: ["record-not-present"],
    }],
  }), /unknown verification record record-not-present/iu);

  await assert.rejects(createImplementationSnapshotArtifact({
    methodSpec,
    routeId: "route-node",
    implementationRoot: roots.implementationRoot,
    verificationRecords: verificationRecords.slice(0, 1),
    observedConclusions: [{
      id: "observed-incomplete",
      expectedConclusionId: "expected-calibration",
      statement: "Only one of three required checks was captured.",
      outcome: "supported",
      verificationRecordIds: [verificationRecords[0]!.id],
    }],
  }), /without passed check check-numerical/iu);
});

test("read-only capture preserves dirty user content and never creates Git state", async () => {
  const roots = await implementationRoots("read-only");
  const methodSpec = createMethodSpecFixture();
  const dirtyPath = join(roots.implementationRoot, "user-dirty-notes.txt");
  const gitMarker = join(roots.implementationRoot, ".git", "dirty-marker");
  await mkdir(join(roots.implementationRoot, ".git"));
  await Promise.all([
    writeFile(dirtyPath, "uncommitted user work\n", "utf8"),
    writeFile(gitMarker, "unchanged\n", "utf8"),
  ]);

  const before = await Promise.all([readFile(dirtyPath, "utf8"), readFile(gitMarker, "utf8")]);
  const snapshot = await createImplementationSnapshotArtifact({
    methodSpec,
    routeId: "route-node",
    implementationRoot: roots.implementationRoot,
  });
  const after = await Promise.all([readFile(dirtyPath, "utf8"), readFile(gitMarker, "utf8")]);

  assert.deepEqual(after, before);
  assert.equal(snapshot.payload.capturePolicy.autoCommit, false);
  assert.equal(snapshot.payload.capturePolicy.dirtyUserWorktree, "preserved");
  assert.equal(snapshot.payload.files.some((file) => file.path.includes(".git")), false);
});
