import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFigureTableArtifact, verifyFigureTableArtifactFiles } from "../../../src/research/manuscript/figureTable.js";
import { hashText } from "../../../src/research/manuscript/validation.js";
import { SYNTHETIC_NOW } from "./fixtures.js";

test("FigureTableArtifact verifies data, script, output, and caption provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigorium-manuscript-figure-"));
  await mkdir(join(root, "data"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "figures"));
  const data = "x,y\n1,2\n";
  const script = "console.log('synthetic fixture');\n";
  const output = "synthetic image bytes";
  await writeFile(join(root, "data", "synthetic.csv"), data, "utf8");
  await writeFile(join(root, "scripts", "synthetic.js"), script, "utf8");
  await writeFile(join(root, "figures", "synthetic.png"), output, "utf8");
  const artifact = createFigureTableArtifact({
    items: [{
      itemId: "synthetic-figure",
      kind: "figure",
      label: "fig:synthetic",
      data: [{ path: "data/synthetic.csv", contentHash: hashText(data), mediaType: "text/csv" }],
      script: {
        status: "available",
        file: { path: "scripts/synthetic.js", contentHash: hashText(script), mediaType: "text/javascript" },
        command: ["node", "scripts/synthetic.js"],
      },
      output: { path: "figures/synthetic.png", contentHash: hashText(output), mediaType: "image/png" },
      captionLatex: "Synthetic fixture caption; no research result.",
      captionEvidenceRefs: [],
      citationKeys: [],
    }],
    producer: { kind: "tool", toolName: "manuscript_latex" },
    now: SYNTHETIC_NOW,
  });

  const verified = await verifyFigureTableArtifactFiles({ projectRoot: root, artifact });
  assert.equal(artifact.payload.items[0]?.reuseStatus, "recomputable");
  assert.equal(verified.status, "verified");

  await writeFile(join(root, "figures", "synthetic.png"), "changed synthetic bytes", "utf8");
  const changed = await verifyFigureTableArtifactFiles({ projectRoot: root, artifact });
  assert.equal(changed.status, "failed");
  assert.equal(changed.files.find((file) => file.path === "figures/synthetic.png")?.status, "hash_mismatch");
});

