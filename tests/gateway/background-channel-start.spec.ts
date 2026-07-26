import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startRigoriumServer } from "../../src/cli/rigoriumServer.js";
import type { ChannelAdapter } from "../../src/adapters/index.js";
import type { Gateway } from "../../src/gateway/index.js";

test("startRigoriumServer listens before a background channel finishes starting", async (t) => {
  const rigoriumHome = await mkdtemp(join(tmpdir(), "rigorium-channel-start-"));
  const previousRigoriumHome = process.env.RIGORIUM_HOME;
  process.env.RIGORIUM_HOME = rigoriumHome;
  t.after(async () => {
    if (previousRigoriumHome === undefined) {
      delete process.env.RIGORIUM_HOME;
    } else {
      process.env.RIGORIUM_HOME = previousRigoriumHome;
    }
    await rm(rigoriumHome, { recursive: true, force: true });
  });

  const stuckChannel: ChannelAdapter = {
    channelKey: "test",
    start: async () => new Promise(() => undefined),
  };

  const server = await startRigoriumServer({
    gateway: {} as Gateway,
    port: 0,
    channels: [stuckChannel],
  });
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`${server.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
