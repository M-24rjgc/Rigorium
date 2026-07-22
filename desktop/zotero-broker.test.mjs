import assert from 'node:assert/strict';
import test from 'node:test';

import { startZoteroBroker } from './zotero-broker.mjs';

async function withBroker(options, run) {
  const broker = await startZoteroBroker(options);
  try {
    await run(broker.url);
  } finally {
    await new Promise((resolve) => broker.server.close(resolve));
  }
}

test('Zotero broker attaches the stored key without returning it', async () => {
  const apiKey = 'not-returned-zotero-secret';
  await withBroker(
    {
      token: 'a'.repeat(48),
      getApiKey: () => apiKey,
      fetchImpl: async (url, options) => {
        assert.equal(url.toString(), 'https://api.zotero.org/users/1/items?format=versions&limit=1');
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers.get('zotero-api-key'), apiKey);
        assert.equal(options.headers.get('zotero-api-version'), '3');
        return new Response(`server echoed ${apiKey}`, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'last-modified-version': '12',
            'x-not-forwarded': 'no',
          },
        });
      },
    },
    async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'a'.repeat(48)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: '/users/1/items?format=versions&limit=1',
          method: 'GET',
          headers: { accept: 'application/json', 'zotero-api-version': '3' },
        }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.status, 200);
      assert.equal(payload.headers['last-modified-version'], '12');
      assert.equal(payload.headers['x-not-forwarded'], undefined);
      assert.equal(payload.body, 'server echoed [redacted]');
      assert.equal(JSON.stringify(payload).includes(apiKey), false);
    },
  );
});

test('Zotero broker serializes an approved JSON array body for batch writes', async () => {
  await withBroker(
    {
      token: 'd'.repeat(48),
      getApiKey: () => 'stored-secret',
      fetchImpl: async (_url, options) => {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.get('content-type'), 'application/json');
        assert.equal(options.body, '[{"itemType":"note","parentItem":"PARENT01","note":"<p>Note</p>"}]');
        return new Response('{"successful":{"0":"ABCDEFGH"}}', { status: 200 });
      },
    },
    async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'d'.repeat(48)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: '/users/1/items',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: [{ itemType: 'note', parentItem: 'PARENT01', note: '<p>Note</p>' }],
        }),
      });
      assert.equal(response.status, 200);
    },
  );
});

test('Zotero broker rejects a bad token, non-Zotero target, and unapproved headers', async () => {
  let calls = 0;
  await withBroker(
    {
      token: 'b'.repeat(48),
      getApiKey: () => 'stored-secret',
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: 200 });
      },
    },
    async (url) => {
      const makeRequest = (token, payload) => fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      assert.equal((await makeRequest('wrong-token', { path: '/users/1/items', method: 'GET' })).status, 401);
      assert.equal((await makeRequest('b'.repeat(48), { path: 'https://example.com/items', method: 'GET' })).status, 400);
      assert.equal((await makeRequest('b'.repeat(48), {
        path: '/users/1/items',
        method: 'GET',
        headers: { authorization: 'Bearer leaked' },
      })).status, 400);
      assert.equal((await makeRequest('b'.repeat(48), { path: '/users/1/settings', method: 'GET' })).status, 403);
      assert.equal((await makeRequest('b'.repeat(48), { path: '/users/1/items/ITEM0001', method: 'PUT' })).status, 405);
      assert.equal((await makeRequest('b'.repeat(48), {
        path: '/users/1/items',
        method: 'POST',
        body: [{ itemType: 'journalArticle', title: 'Not allowed' }],
      })).status, 400);
      assert.equal(calls, 0);
    },
  );
});

test('Zotero broker bounds oversized local request bodies before contacting Zotero', async () => {
  let calls = 0;
  await withBroker(
    {
      token: 'c'.repeat(48),
      getApiKey: () => 'stored-secret',
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: 200 });
      },
    },
    async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'c'.repeat(48)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: '/users/1/items',
          method: 'POST',
          body: 'x'.repeat(512 * 1024),
        }),
      });
      assert.equal(response.status, 413);
      assert.equal(calls, 0);
    },
  );
});

test('Zotero broker forwards a bounded JSON array for Zotero batch creation', async () => {
  await withBroker(
    {
      token: 'd'.repeat(48),
      getApiKey: () => 'stored-secret',
      fetchImpl: async (_url, options) => {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.get('content-type'), 'application/json');
        assert.equal(options.body, JSON.stringify([{ itemType: 'note', parentItem: 'PARENT01', note: '<p>New note</p>' }]));
        return new Response(JSON.stringify({ successful: { 0: { key: 'NOTE0001', version: 2 } } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'last-modified-version': '2' },
        });
      },
    },
    async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'d'.repeat(48)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: '/users/1/items',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: [{ itemType: 'note', parentItem: 'PARENT01', note: '<p>New note</p>' }],
        }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.status, 200);
      assert.match(payload.body, /NOTE0001/);
    },
  );
});

test('Zotero broker deletes only an inspected note item', async () => {
  const methods = [];
  await withBroker(
    {
      token: 'e'.repeat(48),
      getApiKey: () => 'stored-secret',
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        if (options.method === 'GET') {
          return new Response(JSON.stringify({ key: 'NOTE0001', data: { itemType: 'note' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 204, headers: { 'last-modified-version': '3' } });
      },
    },
    async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'e'.repeat(48)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: '/users/1/items/NOTE0001',
          method: 'DELETE',
          headers: { 'if-unmodified-since-version': '2' },
        }),
      });
      assert.equal(response.status, 204);
      assert.deepEqual(methods, ['GET', 'DELETE']);
    },
  );
});

test('Zotero broker refuses to delete a non-note library item', async () => {
  let calls = 0;
  await withBroker(
    {
      token: 'f'.repeat(48),
      getApiKey: () => 'stored-secret',
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ key: 'PAPER001', data: { itemType: 'journalArticle' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
    async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'f'.repeat(48)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: '/users/1/items/PAPER001',
          method: 'DELETE',
          headers: { 'if-unmodified-since-version': '2' },
        }),
      });
      assert.equal(response.status, 403);
      assert.equal(calls, 1);
    },
  );
});
