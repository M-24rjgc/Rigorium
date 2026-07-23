import assert from "node:assert/strict";
import test from "node:test";
import {
  LiteratureSearchSemanticsError,
  normalizeLiteratureSearchMode,
  normalizeLiteratureSearchQuerySemantics,
} from "../../src/research/literature/searchSemantics.js";

test("specific search semantics preserve multilingual terminology provenance without inventing a translation", () => {
  const result = normalizeLiteratureSearchQuerySemantics({
    mode: "specific",
    query: "大语言模型幻觉评估",
    language: "zh-hans",
    specificity: {
      focus: "Measure hallucination evaluation methods for instruction-following models.",
      requiredConcepts: ["hallucination", "evaluation"],
      excludedConcepts: ["image generation"],
    },
    queryVariants: [
      {
        query: "large language model hallucination evaluation",
        language: "en",
        provenance: {
          kind: "translation",
          sourceVariantId: "primary",
          sourceLanguage: "zh-Hans",
          method: "agent_selected",
        },
      },
      {
        query: "factuality evaluation",
        language: "en",
        rationale: "A related evaluation term selected from a prior evidence artifact.",
        provenance: {
          kind: "terminology_candidate",
          artifactId: "literature-prior-evidence",
          candidateIds: ["openalex:observed_keyword:K1"],
        },
      },
    ],
  });

  assert.equal(result.mode, "specific");
  assert.equal(result.language.tag, "zh-Hans");
  assert.deepEqual(result.specificity, {
    focus: "Measure hallucination evaluation methods for instruction-following models.",
    requiredConcepts: ["hallucination", "evaluation"],
    excludedConcepts: ["image generation"],
  });
  assert.deepEqual(result.queryVariants.map((variant) => [
    variant.id,
    variant.language.tag,
    variant.provenance.kind,
  ]), [
    ["primary", "zh-Hans", "agent_selected"],
    ["alternative-1", "en", "translation"],
    ["alternative-2", "en", "terminology_candidate"],
  ]);
  assert.deepEqual(result.queryVariants[1]?.provenance, {
    kind: "translation",
    sourceVariantId: "primary",
    sourceLanguage: "zh-Hans",
    method: "agent_selected",
  });
});

test("specific search semantics require a declared scope while broad mode stays scope-free", () => {
  assert.throws(() => normalizeLiteratureSearchQuerySemantics({
    mode: "specific",
    query: "causal representation learning",
  }), LiteratureSearchSemanticsError);

  assert.throws(() => normalizeLiteratureSearchQuerySemantics({
    mode: "broad",
    query: "causal representation learning",
    specificity: { focus: "This must not silently narrow a broad query." },
  }), LiteratureSearchSemanticsError);

  const broad = normalizeLiteratureSearchQuerySemantics({ query: "causal representation learning" });
  assert.equal(broad.mode, "broad");
  assert.equal(broad.language.tag, "und");
  assert.equal(broad.language.source, "undetermined");
  assert.equal(broad.queryVariants.length, 1);
});

test("multilingual variants fail closed when translation or terminology provenance is inconsistent", () => {
  assert.throws(() => normalizeLiteratureSearchQuerySemantics({
    query: "large language models",
    language: "en",
    queryVariants: [{
      query: "大语言模型",
      language: "zh-Hans",
      provenance: {
        kind: "translation",
        sourceVariantId: "alternative-2",
        sourceLanguage: "en",
      },
    }],
  }), /earlier query variant/);

  assert.throws(() => normalizeLiteratureSearchQuerySemantics({
    query: "large language models",
    language: "en",
    queryVariants: [{
      query: "大语言模型",
      language: "zh-Hans",
      provenance: {
        kind: "translation",
        sourceVariantId: "primary",
        sourceLanguage: "fr",
      },
    }],
  }), /must match/);

  assert.throws(() => normalizeLiteratureSearchQuerySemantics({
    query: "large language models",
    language: "en",
    queryVariants: [{
      query: "大语言模型",
      language: "zh-Hans",
      provenance: {
        kind: "terminology_candidate",
        artifactId: "evidence-artifact",
        candidateIds: [],
      },
    }],
  }), /at least one candidate ID/);

  assert.throws(() => normalizeLiteratureSearchQuerySemantics({
    query: "large language models",
    language: "en",
    queryVariants: [{
      query: "大语言模型",
      language: "zh-Hans",
    }],
  }), /needs translation or terminology provenance/);
});

test("mode vocabulary makes citation and deep routing explicit without accepting them as query search", () => {
  assert.equal(normalizeLiteratureSearchMode("citation"), "citation");
  assert.equal(normalizeLiteratureSearchMode("deep"), "deep");
  assert.throws(() => normalizeLiteratureSearchMode("question"), LiteratureSearchSemanticsError);
  assert.throws(() => normalizeLiteratureSearchQuerySemantics({
    mode: "citation",
    query: "ignored by the dedicated citation tool",
  }), /dedicated literature tool/);
});
