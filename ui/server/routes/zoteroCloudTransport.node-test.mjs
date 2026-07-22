import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureDesktopZoteroCloudTransport,
  createZoteroCloudTransport,
  isAuthorizedDesktopZoteroCloudRequest,
} from './zoteroCloudTransport.js';

test('cloud transport sends a broker token without a Zotero API key and parses the broker response', async () => {
  const calls = [];
  const transport = createZoteroCloudTransport({
    brokerUrl: 'http://127.0.0.1:45678/v1/zotero/request',
    brokerToken: 'broker-token-only',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        status: 200,
        headers: { 'last-modified-version': '18' },
        body: JSON.stringify({ ITEM1: 18 }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const result = await transport.request({
    path: '/users/42/items?format=versions',
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.headers, { 'last-modified-version': '18' });
  assert.deepEqual(result.body, { ITEM1: 18 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:45678/v1/zotero/request');
  assert.equal(calls[0]?.options.headers.Authorization, 'Bearer broker-token-only');
  assert.equal(JSON.stringify(calls[0]?.options).includes('Zotero-API-Key'), false);
  assert.equal(JSON.stringify(calls[0]?.options).includes('broker-token-only'), true);
});

test('cloud transport reports secure-storage absence as unavailable without issuing a network request', async () => {
  let calls = 0;
  const transport = createZoteroCloudTransport({
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}');
    },
  });

  const result = await transport.request({ path: '/keys/current', method: 'GET' });
  assert.equal(result.status, 503);
  assert.equal(calls, 0);
  assert.match(String(result.body?.error), /Secure Zotero cloud credentials/i);
});

test('desktop broker configuration stays in process memory instead of environment variables', async () => {
  const token = 'private-broker-token'.padEnd(48, 'x');
  const routeToken = 'private-route-token'.padEnd(48, 'y');
  configureDesktopZoteroCloudTransport({
    url: 'http://127.0.0.1:45679/v1/zotero/request',
    token,
    routeToken,
  });
  const transport = createZoteroCloudTransport({
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:45679/v1/zotero/request');
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      return new Response(JSON.stringify({
        status: 200,
        headers: {},
        body: '{}',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(process.env.PILOTDECK_ZOTERO_BROKER_URL, undefined);
  assert.equal(process.env.PILOTDECK_ZOTERO_BROKER_TOKEN, undefined);
  assert.equal(isAuthorizedDesktopZoteroCloudRequest(routeToken), true);
  assert.equal(isAuthorizedDesktopZoteroCloudRequest(`${routeToken}x`), false);
  assert.equal((await transport.request({ path: '/keys/current', method: 'GET' })).status, 200);
});
