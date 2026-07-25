import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ICLR_2026_TEMPLATE_PIN,
  getOfficialIclrTemplatePin,
  probeIclrTemplate,
} from "../../../src/research/manuscript/template.js";

test("official ICLR pins stop at the actually verified 2026 template", () => {
  assert.equal(getOfficialIclrTemplatePin(2026)?.commit, "a28d335b0d46a3c39b205704a65faf41c9748433");
  assert.equal(getOfficialIclrTemplatePin(2027), undefined);
  assert.equal(ICLR_2026_TEMPLATE_PIN.licenseStatus, "not_declared_by_repository");
  assert.equal(ICLR_2026_TEMPLATE_PIN.redistribution, "external_fetch_or_user_supplied_only");
});

test("ICLR template probe distinguishes directory structure from pinned archive integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-iclr-template-"));
  for (const name of ICLR_2026_TEMPLATE_PIN.requiredFiles) {
    await writeFile(join(root, name), `% synthetic placeholder for ${name}\n`, "utf8");
  }
  const directory = await probeIclrTemplate({ conferenceYear: 2026, directoryPath: root });
  assert.equal(directory.status, "structure_verified");

  const fakeArchive = join(root, "iclr2026.zip");
  await writeFile(fakeArchive, "not the official archive", "utf8");
  const archive = await probeIclrTemplate({ conferenceYear: 2026, archivePath: fakeArchive });
  assert.equal(archive.status, "hash_mismatch");

  const future = await probeIclrTemplate({ conferenceYear: 2027, directoryPath: root });
  assert.equal(future.status, "unverified_year");
});

