import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runVerificationCheck,
  type VerificationCheckSpec,
} from "../../../src/research/method/index.js";

async function isolatedRoots(label: string): Promise<{ projectRoot: string; workspaceRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), `rigorium-method-verification-${label}-`));
  const projectRoot = join(base, "project");
  const workspaceRoot = join(base, "workspace");
  await Promise.all([mkdir(projectRoot), mkdir(workspaceRoot)]);
  return { projectRoot, workspaceRoot };
}

function check(input: Partial<VerificationCheckSpec> & Pick<VerificationCheckSpec, "id" | "kind">): VerificationCheckSpec {
  return {
    command: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    timeoutMs: 10_000,
    expectedExitCode: 0,
    stdoutIncludes: [],
    numericalExpectations: [],
    ...input,
  };
}

test("unit, numerical, and smoke checks execute in a separate workspace without a shell", async () => {
  const roots = await isolatedRoots("three-kinds");
  const checks: VerificationCheckSpec[] = [
    check({
      id: "unit-check",
      kind: "unit",
      args: ["-e", "process.stdout.write('unit-ok')"],
      stdoutIncludes: ["unit-ok"],
    }),
    check({
      id: "numerical-check",
      kind: "numerical",
      args: ["-e", "process.stdout.write(JSON.stringify({loss:0.105,metrics:{score:0.91}}))"],
      numericalExpectations: [
        { key: "loss", expected: 0.1, absoluteTolerance: 0.01 },
        { key: "metrics.score", expected: 0.9, absoluteTolerance: 0.02 },
      ],
    }),
    check({
      id: "smoke-check",
      kind: "smoke",
      args: ["-e", "process.stdout.write('smoke-ok')"],
      stdoutIncludes: ["smoke-ok"],
    }),
  ];

  const records = await Promise.all(checks.map((candidate, index) => runVerificationCheck({
    ...roots,
    check: candidate,
    recordId: `record-${index}`,
    now: new Date("2026-07-25T02:00:00.000Z"),
  })));

  assert.deepEqual(records.map((record) => record.status), ["passed", "passed", "passed"]);
  assert.deepEqual(records.map((record) => record.workspaceMode), ["isolated", "isolated", "isolated"]);
  assert.equal(records.every((record) => /^sha256:[a-f0-9]{64}$/u.test(record.stdoutHash)), true);
  assert.equal(records.every((record) => /^sha256:[a-f0-9]{64}$/u.test(record.stderrHash)), true);
  assert.equal(records.every((record) => record.exitCode === 0 && record.durationMs >= 0), true);
  assert.deepEqual(records[1]?.numericalResults.map((result) => result.passed), [true, true]);
});

test("failed exit, missing stdout, and out-of-tolerance JSON remain explicit records", async () => {
  const roots = await isolatedRoots("failures");
  const failedExit = await runVerificationCheck({
    ...roots,
    check: check({
      id: "exit-check",
      kind: "unit",
      args: ["-e", "process.stderr.write('failed');process.exit(4)"],
      stdoutIncludes: ["required-output"],
    }),
  });
  assert.equal(failedExit.status, "failed");
  assert.equal(failedExit.exitCode, 4);
  assert.match(failedExit.failureMessage ?? "", /expected 0/iu);
  assert.match(failedExit.failureMessage ?? "", /did not include/iu);
  assert.equal(failedExit.stderrBytes > 0, true);

  const numerical = await runVerificationCheck({
    ...roots,
    check: check({
      id: "numerical-failure",
      kind: "numerical",
      args: ["-e", "process.stdout.write(JSON.stringify({score:0.5}))"],
      numericalExpectations: [{ key: "score", expected: 0.9, absoluteTolerance: 0.01 }],
    }),
  });
  assert.equal(numerical.status, "failed");
  assert.deepEqual(numerical.numericalResults, [{
    key: "score",
    expected: 0.9,
    actual: 0.5,
    absoluteTolerance: 0.01,
    passed: false,
  }]);
});

test("the verifier rejects the project root and any nested workspace", async () => {
  const roots = await isolatedRoots("boundaries");
  const candidate = check({ id: "unit-boundary", kind: "unit" });
  await assert.rejects(
    runVerificationCheck({ projectRoot: roots.projectRoot, workspaceRoot: roots.projectRoot, check: candidate }),
    /separate from the project root/iu,
  );
  const nested = join(roots.projectRoot, "nested");
  await mkdir(nested);
  await assert.rejects(
    runVerificationCheck({ projectRoot: roots.projectRoot, workspaceRoot: nested, check: candidate }),
    /separate from the project root/iu,
  );
});

test("pre-cancelled and timed-out checks preserve their distinct failure states", async () => {
  const roots = await isolatedRoots("interruptions");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runVerificationCheck({
    ...roots,
    check: check({ id: "cancelled-check", kind: "smoke" }),
    abortSignal: controller.signal,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.exitCode, null);

  const timedOut = await runVerificationCheck({
    ...roots,
    check: check({
      id: "timeout-check",
      kind: "smoke",
      args: ["-e", "setTimeout(()=>process.exit(0),5000)"],
      timeoutMs: 25,
      stdoutIncludes: ["never-produced"],
    }),
  });
  assert.equal(timedOut.status, "timeout");
  assert.match(timedOut.failureMessage ?? "", /25ms timeout/iu);
});
