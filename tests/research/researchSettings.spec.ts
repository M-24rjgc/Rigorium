import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  DEFAULT_RESEARCH_SETTINGS,
  readResearchSettings,
  writeResearchSettings,
} from "../../src/research/settings.js";

test("research settings enable arXiv metadata search by default", () => {
  assert.equal(DEFAULT_RESEARCH_SETTINGS.literature.sources.arxiv.enabled, true);
});

test("research settings merge global defaults with an enabled project override", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-research-settings-"));
  const rigoriumHome = join(root, "rigorium-home");
  const projectRoot = join(root, "project");

  await writeResearchSettings({
    scope: "global",
    rigoriumHome,
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
    rigoriumHome,
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

  const snapshot = await readResearchSettings({ rigoriumHome, projectRoot });
  assert.equal(snapshot.global.literature.search.defaultLimit, 8);
  assert.equal(snapshot.projectOverride?.enabled, true);
  assert.equal(snapshot.effective.literature.search.defaultLimit, 5);
  assert.match(snapshot.paths.project ?? "", /\.rigorium[\\/]research[\\/]settings\.json$/);
});

test("research settings reject non-loopback Zotero endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-research-settings-url-"));
  await assert.rejects(
    writeResearchSettings({
      scope: "global",
      rigoriumHome: root,
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
    rigoriumHome: join(root, "rigorium-home"),
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

  const snapshot = await readResearchSettings({ rigoriumHome: join(root, "rigorium-home"), projectRoot });
  assert.equal(snapshot.effective.zotero.collectionKey, "ABCD1234");
  assert.equal(snapshot.effective.zotero.collectionName, "Project Evidence");
  assert.equal(snapshot.effective.zotero.useSelectedCollection, false);
});

test("research settings retain only non-secret Zotero cloud selection data", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-research-zotero-cloud-"));
  const rigoriumHome = join(root, "rigorium-home");
  await writeResearchSettings({
    scope: "global",
    rigoriumHome,
    settings: {
      ...DEFAULT_RESEARCH_SETTINGS,
      zotero: {
        ...DEFAULT_RESEARCH_SETTINGS.zotero,
        cloud: {
          enabled: true,
          libraryType: "group",
          libraryId: "42",
          // This deliberately simulates an untyped caller. Settings must not
          // become a credential store even if one supplies an extra field.
          apiKey: "must-not-be-written",
        } as typeof DEFAULT_RESEARCH_SETTINGS.zotero.cloud,
      },
    },
  });

  const snapshot = await readResearchSettings({ rigoriumHome });
  const raw = await readFile(snapshot.paths.global, "utf8");
  assert.deepEqual(snapshot.effective.zotero.cloud, {
    enabled: true,
    libraryType: "group",
    libraryId: "42",
  });
  assert.equal(raw.includes("must-not-be-written"), false);
  assert.equal(raw.toLowerCase().includes("apikey"), false);
});

test("research settings reject invalid enabled Zotero cloud group IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-research-zotero-cloud-id-"));
  await assert.rejects(
    writeResearchSettings({
      scope: "global",
      rigoriumHome: root,
      settings: {
        ...DEFAULT_RESEARCH_SETTINGS,
        zotero: {
          ...DEFAULT_RESEARCH_SETTINGS.zotero,
          cloud: { enabled: true, libraryType: "group", libraryId: "not-a-positive-id" },
        },
      },
    }),
    /positive integer/,
  );
});
