import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEvidencePack,
  captureZoteroAttachmentEvidence,
  createEvidencePackArtifact,
  hashEvidenceSnapshot,
  validateEvidencePack,
  verifyEvidenceSnapshot,
} from "../../src/research/literature/evidencePack.js";

const now = new Date("2026-07-25T01:02:03.000Z");

test("evidence packs retain page and paragraph locators with immutable source hashes", () => {
  const artifact = createEvidencePackArtifact({
    artifactId: "evidence-review",
    producer: { kind: "tool", toolName: "zotero-fulltext" },
    now,
    entries: [{
      id: "claim-1",
      paperId: "doi:10.1000/example",
      locator: {
        sourceId: "zotero",
        recordId: "ABCD1234",
        url: "zotero://open-pdf/library/items/ABCD1234?page=4",
        page: 5,
        paragraph: 2,
      },
      snapshot: { content: "The source paragraph used by the claim.", mediaType: "text/plain" },
      quote: "The source paragraph",
    }],
  });

  assert.equal(artifact.kind, "evidence_pack");
  assert.equal(artifact.payload.entries[0]!.locator.page, 5);
  assert.equal(artifact.payload.entries[0]!.locator.paragraph, 2);
  assert.equal(artifact.payload.entries[0]!.snapshot.contentHash, hashEvidenceSnapshot("The source paragraph used by the claim."));
  assert.equal(artifact.sources[0]!.contentHash, artifact.payload.entries[0]!.snapshot.contentHash);
  assert.equal(verifyEvidenceSnapshot(artifact.payload.entries[0]!.snapshot), true);
  assert.doesNotThrow(() => validateEvidencePack(artifact.payload));
});

test("evidence packs reject unlocatable excerpts and mismatched snapshot hashes", () => {
  assert.throws(() => buildEvidencePack({
    now,
    entries: [{
      id: "missing-locator",
      paperId: "paper-1",
      locator: { sourceId: "crossref" },
      snapshot: { content: "An excerpt." },
    }],
  }), /page, paragraph, section, or characterStart/u);

  assert.throws(() => buildEvidencePack({
    now,
    entries: [{
      id: "bad-hash",
      paperId: "paper-1",
      locator: { sourceId: "arxiv", page: 1 },
      snapshot: { content: "An excerpt.", contentHash: `sha256:${"0".repeat(64)}` },
    }],
  }), /does not match/u);
});

test("Zotero attachment evidence uses only the existing full-text provider", async () => {
  let requestedKey = "";
  const artifact = await captureZoteroAttachmentEvidence({
    provider: {
      getAttachmentFullText: async (attachmentKey) => {
        requestedKey = attachmentKey;
        return {
          attachmentKey,
          content: "First paragraph. Evidence paragraph from Zotero.",
          truncated: true,
          indexedPages: 3,
          totalPages: 5,
          totalChars: 48,
        };
      },
    },
    attachmentKey: "ATTACH01",
    paperId: "zotero:PAPER01",
    entryId: "zotero-claim",
    locator: { page: 3, paragraph: 2 },
    quote: "Evidence paragraph from Zotero.",
    producer: { kind: "tool", toolName: "zotero-local-api" },
    artifactId: "zotero-evidence",
    now,
  });

  assert.equal(requestedKey, "ATTACH01");
  assert.equal(artifact.payload.entries[0]!.locator.sourceId, "zotero");
  assert.equal(artifact.payload.entries[0]!.snapshot.truncated, true);
  assert.equal(artifact.payload.entries[0]!.snapshot.indexedPages, 3);
});
