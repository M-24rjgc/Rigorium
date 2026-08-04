import assert from "node:assert/strict";
import test from "node:test";

import { ProviderHealthTracker } from "../../src/router/health/ProviderHealthTracker.js";

function createTracker(overrides: ConstructorParameters<typeof ProviderHealthTracker>[0] = {}) {
  const clock = { value: 0 };
  const tracker = new ProviderHealthTracker({ now: () => clock.value, ...overrides });
  return { tracker, clock };
}

function degradeToOpen(tracker: ProviderHealthTracker, provider = "p1", failures = 5): void {
  for (let i = 0; i < failures; i += 1) {
    tracker.recordFailure(provider, "server_error");
  }
}

test("health: open → half_open after the open duration, probes let through while budget remains", () => {
  const { tracker, clock } = createTracker({ openThreshold: 5, openDurationMs: 10_000, halfOpenProbes: 3 });
  degradeToOpen(tracker);
  assert.equal(tracker.getState("p1"), "open");
  assert.equal(tracker.shouldSkip("p1"), true, "open circuits skip");

  clock.value += 10_000;
  assert.equal(tracker.getState("p1"), "half_open");
  // Probe budget of 3: concurrent requests are all let through while the
  // window is unresolved (no requests blocked before the budget is used).
  assert.equal(tracker.shouldSkip("p1"), false, "probe #1 allowed");
  assert.equal(tracker.shouldSkip("p1"), false, "probe #2 allowed");
  assert.equal(tracker.shouldSkip("p1"), false, "probe #3 allowed");
  // The window resolves once the probe results land (see ratio tests);
  // a failure recorded while open does not count as a probe.
  tracker.recordFailure("p1", "server_error");
  assert.equal(tracker.getState("p1"), "half_open", "failure before window start is not a probe");
});

test("health: half-open window all-success recovers the provider", () => {
  const { tracker, clock } = createTracker({ openThreshold: 5, openDurationMs: 10_000, halfOpenProbes: 3 });
  degradeToOpen(tracker);
  clock.value += 10_000;
  assert.equal(tracker.getState("p1"), "half_open");

  tracker.recordSuccess("p1");
  assert.equal(tracker.getState("p1"), "half_open", "a single success does NOT close yet (ratio window)");
  tracker.recordSuccess("p1");
  tracker.recordSuccess("p1");
  assert.equal(tracker.getState("p1"), "healthy", "window all-success → healthy");
  assert.equal(tracker.shouldSkip("p1"), false);
});

test("health: half-open failure ratio reopens the circuit with backoff memory", () => {
  const { tracker, clock } = createTracker({
    openThreshold: 5,
    openDurationMs: 10_000,
    maxOpenDurationMs: 80_000,
    halfOpenProbes: 3,
    halfOpenFailureRatio: 0.5,
  });
  degradeToOpen(tracker);
  clock.value += 10_000;
  assert.equal(tracker.getState("p1"), "half_open");

  // 2 failures of 3 probes → ratio 0.67 ≥ 0.5 → reopen.
  tracker.recordFailure("p1", "server_error");
  tracker.recordSuccess("p1");
  tracker.recordFailure("p1", "server_error");
  assert.equal(tracker.getState("p1"), "open", "ratio ≥ threshold reopens");
  assert.equal(tracker.shouldSkip("p1"), true);

  // Backoff memory: the second open cycle waits 2× the base duration.
  clock.value += 10_000;
  assert.equal(tracker.getState("p1"), "open", "first cycle duration no longer applies");
  clock.value += 10_000;
  assert.equal(tracker.getState("p1"), "half_open", "second cycle waits 20s (2× base)");

  // Recover fully: openCount resets.
  tracker.recordSuccess("p1");
  tracker.recordSuccess("p1");
  tracker.recordSuccess("p1");
  assert.equal(tracker.getState("p1"), "healthy");

  // Third failure cycle starts from the base duration again.
  degradeToOpen(tracker);
  clock.value += 10_000;
  assert.equal(tracker.getState("p1"), "half_open", "openCount reset → base duration again");
});

test("health: a single flaky failure in the probe window does not reopen", () => {
  const { tracker, clock } = createTracker({ openThreshold: 5, openDurationMs: 10_000, halfOpenProbes: 3 });
  degradeToOpen(tracker);
  clock.value += 10_000;
  tracker.recordFailure("p1", "timeout");
  assert.equal(tracker.getState("p1"), "half_open", "one flaky failure keeps probing");
  tracker.recordSuccess("p1");
  tracker.recordSuccess("p1");
  assert.equal(tracker.getState("p1"), "healthy", "1/3 failures < 0.5 ratio → recovered");
});

test("health: degraded → open transition counts one open cycle per transition", () => {
  const { tracker } = createTracker({ openThreshold: 5, openDurationMs: 10_000 });
  degradeToOpen(tracker);
  // Extra failures while already open must not inflate openCount.
  for (let i = 0; i < 3; i += 1) {
    tracker.recordFailure("p1", "server_error");
  }
  const snapshot = tracker.snapshot().get("p1")!;
  assert.equal(snapshot.openCount, 1);
  assert.equal(snapshot.state, "open");
});
