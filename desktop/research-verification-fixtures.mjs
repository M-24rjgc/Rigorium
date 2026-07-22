/** Deterministic OpenAlex response for packaged terminology verification. */
export function terminologyVerificationFixture() {
  const work = (id, doi, label) => ({
    id: `https://openalex.org/${id}`,
    doi,
    display_name: `Packaged terminology ${label} paper`,
    keywords: Array.from({ length: 9 }, (_, index) => ({
      id: `https://openalex.org/keywords/${label.toLowerCase()}-${String(index + 1).padStart(2, '0')}`,
      display_name: `Fixture ${label} keyword ${String(index + 1).padStart(2, '0')}`,
      score: 0.99 - index * 0.01,
    })),
    topics: [],
    primary_topic: null,
  });
  return {
    meta: { count: 3 },
    results: [
      work('W-TERM-1', 'https://doi.org/10.1000/rigorium-terminology-fixture', 'Alpha'),
      work('W-TERM-2', 'https://doi.org/10.1000/rigorium-terminology-fixture', 'Beta'),
      work('W-TERM-3', 'https://doi.org/10.1000/rigorium-terminology-excluded', 'Excluded'),
    ],
  };
}
