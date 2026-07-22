import assert from 'node:assert/strict';
import test from 'node:test';

import { terminologyVerificationFixture } from './research-verification-fixtures.mjs';

test('terminology verification fixture keeps duplicate and excluded OpenAlex identities distinct', () => {
  const fixture = terminologyVerificationFixture();
  assert.equal(fixture.meta.count, 3);
  assert.equal(fixture.results.length, 3);
  assert.equal(fixture.results[0].doi, fixture.results[1].doi);
  assert.notEqual(fixture.results[0].doi, fixture.results[2].doi);
  assert.deepEqual(
    fixture.results.map((work) => work.keywords.length),
    [9, 9, 9],
  );
  assert.equal(
    fixture.results.flatMap((work) => work.keywords).every((keyword) => (
      typeof keyword.id === 'string'
      && typeof keyword.display_name === 'string'
      && typeof keyword.score === 'number'
      && keyword.score >= 0.3
    )),
    true,
  );
});
