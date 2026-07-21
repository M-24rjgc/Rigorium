import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  DEFAULT_RESEARCH_SETTINGS,
  readResearchSettings,
  writeResearchSettings,
} from "../../src/research/settings.js";

test("research settings merge global defaults with an enabled project override", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-research-settings-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");

  await writeResearchSettings({
    scope: "global",
    pilotHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        search: { ...DEFAULT_RESEARCH_SETTINGS.literature.search, defaultLimit: 8 },
      },
    },
  });
  await writeResearchSettings({
    scope: "project",
    pilotHome,
    projectRoot,
    projectOverrideEnabled: true,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      literature: {
        ...DEFAULT_RESEARCH_SETTINGS.literature,
        search: { ...DEFAULT_RESEARCH_SETTINGS.literature.search, defaultLimit: 5 },
      },
    },
  });

  const snapshot = await readResearchSettings({ pilotHome, projectRoot });
  assert.equal(snapshot.global.literature.search.defaultLimit, 8);
  assert.equal(snapshot.projectOverride?.enabled, true);
  assert.equal(snapshot.effective.literature.search.defaultLimit, 5);
  assert.match(snapshot.paths.project ?? "", /\.pilotdeck[\\/]research[\\/]settings\.json$/);
});

test("research settings reject non-loopback Zotero endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-research-settings-url-"));
  await assert.rejects(
    writeResearchSettings({
      scope: "global",
      pilotHome: root,
      settings: {
        ...DEFAULT_RESEARCH_SETTINGS,
        zotero: { ...DEFAULT_RESEARCH_SETTINGS.zotero, baseUrl: "https://example.com" },
      },
    }),
    /loopback/,
  );
});

test("research settings preserve a project Zotero collection binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-research-zotero-binding-"));
  const projectRoot = join(root, "project");
  await writeResearchSettings({
    scope: "project",
    pilotHome: join(root, "pilot-home"),
    projectRoot,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      zotero: {
        ...DEFAULT_RESEARCH_SETTINGS.zotero,
        useSelectedCollection: false,
        collectionKey: "ABCD1234",
        collectionName: "Project Evidence",
      },
    },
  });

  const snapshot = await readResearchSettings({ pilotHome: join(root, "pilot-home"), projectRoot });
  assert.equal(snapshot.effective.zotero.collectionKey, "ABCD1234");
  assert.equal(snapshot.effective.zotero.collectionName, "Project Evidence");
  assert.equal(snapshot.effective.zotero.useSelectedCollection, false);
});
