import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const BROKER_PATH = '/v1/zotero/request';
const ZOTERO_ORIGIN = 'https://api.zotero.org';
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const ALLOWED_RESPONSE_HEADERS = new Set([
  'backoff',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'last-modified-version',
  'link',
  'retry-after',
  'total-results',
  'zotero-api-version',
  'zotero-library-version',
  'zotero-write-token',
]);

class BrokerRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function writeJson(response, status, payload) {
  if (response.writableEnded) return;
  const encoded = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
  });
  response.end(encoded);
}

function equalsBearerToken(value, expectedToken) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const receivedToken = value.slice('Bearer '.length);
  const expected = Buffer.from(expectedToken, 'utf8');
  const received = Buffer.from(receivedToken, 'utf8');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const contentLength = Number.parseInt(request.headers['content-length'] || '', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      request.resume();
      reject(new BrokerRequestError('Request body is too large.', 413));
      return;
    }

    let totalBytes = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        fail(new BrokerRequestError('Request body is too large.', 413));
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', () => fail(new BrokerRequestError('Unable to read request body.', 400)));
    request.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrokerRequestError(`${name} must be an object.`);
  }
  return value;
}

function normalizeRequestHeaders(headers) {
  if (headers === undefined) return new Headers();
  requireObject(headers, 'headers');
  const normalized = new Headers();

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (typeof rawValue !== 'string' || rawValue.length === 0 || rawValue.length > 512 || /[\r\n]/.test(rawValue)) {
      throw new BrokerRequestError(`Invalid value for ${rawName}.`);
    }
    if (normalized.has(name)) throw new BrokerRequestError(`Duplicate header ${rawName}.`);

    if (name === 'accept') {
      normalized.set(name, rawValue);
      continue;
    }
    if (name === 'content-type') {
      const mediaType = rawValue.split(';', 1)[0].trim().toLowerCase();
      if (mediaType === 'application/json' || mediaType === 'application/x-www-form-urlencoded') {
        normalized.set(name, rawValue);
        continue;
      }
      throw new BrokerRequestError('Unsupported content-type.');
    }
    if (name === 'if-modified-since-version' || name === 'if-unmodified-since-version' || name === 'zotero-library-version') {
      if (/^\d+$/.test(rawValue)) {
        normalized.set(name, rawValue);
        continue;
      }
      throw new BrokerRequestError(`Invalid version header ${rawName}.`);
    }
    if (name === 'zotero-write-token') {
      if (/^[A-Za-z0-9._-]{1,128}$/.test(rawValue)) {
        normalized.set(name, rawValue);
        continue;
      }
      throw new BrokerRequestError('Invalid Zotero write token.');
    }
    if (name === 'zotero-api-version' && rawValue === '3') {
      normalized.set(name, rawValue);
      continue;
    }
    throw new BrokerRequestError(`Header ${rawName} is not allowed.`);
  }

  return normalized;
}

function normalizeTargetPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || !value.startsWith('/') || value.includes('#')) {
    throw new BrokerRequestError('A relative Zotero API path is required.');
  }
  let target;
  try {
    target = new URL(value, ZOTERO_ORIGIN);
  } catch {
    throw new BrokerRequestError('Invalid Zotero API path.');
  }
  if (target.origin !== ZOTERO_ORIGIN || target.username || target.password) {
    throw new BrokerRequestError('Only api.zotero.org requests are allowed.');
  }
  return target;
}

function normalizeBody(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_REQUEST_BYTES) throw new BrokerRequestError('Outbound request body is too large.', 413);
    return value;
  }
  if (typeof value === 'object') {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new BrokerRequestError('Outbound request body must be serializable JSON.');
    }
    if (typeof serialized !== 'string') throw new BrokerRequestError('Outbound request body is invalid.');
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
      throw new BrokerRequestError('Outbound request body is too large.', 413);
    }
    return serialized;
  }
  throw new BrokerRequestError('Outbound request body must be a string, JSON object, or JSON array.');
}

function parseBrokerRequest(value) {
  const payload = requireObject(value, 'request');
  for (const key of Object.keys(payload)) {
    if (!['path', 'method', 'headers', 'body'].includes(key)) {
      throw new BrokerRequestError(`Unknown request field ${key}.`);
    }
  }
  if (typeof payload.method !== 'string') throw new BrokerRequestError('An HTTP method is required.');
  const method = payload.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new BrokerRequestError(`Method ${method} is not allowed.`, 405);
  const body = normalizeBody(payload.body);
  if ((method === 'GET' || method === 'HEAD') && body !== undefined) {
    throw new BrokerRequestError(`${method} requests cannot contain a body.`);
  }
  const target = normalizeTargetPath(payload.path);
  assertAllowedZoteroRequest(target, method, body);
  return {
    target,
    method,
    headers: normalizeRequestHeaders(payload.headers),
    body,
  };
}

function assertAllowedZoteroRequest(target, method, body) {
  if (target.pathname === '/keys/current') {
    if (method !== 'GET' || target.search) throw new BrokerRequestError('This Zotero credential request is not allowed.', 405);
    return;
  }

  const match = target.pathname.match(/^\/(users|groups)\/([1-9]\d*)\/(items|collections|deleted)(?:\/([A-Za-z0-9]{1,32}))?$/);
  if (!match) throw new BrokerRequestError('This Zotero API path is not allowed.', 403);
  const resource = match[3];
  const itemKey = match[4];

  if (resource === 'deleted') {
    if (itemKey || method !== 'GET') throw new BrokerRequestError('This Zotero deleted-items request is not allowed.', 405);
    assertQuery(target, { since: 'version' });
    return;
  }
  if (resource === 'collections') {
    if (itemKey || method !== 'GET') throw new BrokerRequestError('This Zotero collections request is not allowed.', 405);
    assertQuery(target, { format: 'versions', since: 'version' }, ['format']);
    return;
  }
  if (!itemKey) {
    if (method === 'GET') {
      assertQuery(target, { format: 'versions', limit: 'limit', since: 'version', includeTrashed: 'boolean' }, ['format']);
      return;
    }
    if (method === 'POST' && !target.search) {
      assertNoteCreationBody(body);
      return;
    }
    throw new BrokerRequestError('This Zotero items request is not allowed.', 405);
  }
  if (target.search) throw new BrokerRequestError('Item requests cannot contain query parameters.');
  if (method === 'GET') return;
  if (method === 'PATCH') {
    assertItemPatchBody(body);
    return;
  }
  if (method === 'DELETE' && body === undefined) return;
  throw new BrokerRequestError('This Zotero item request is not allowed.', 405);
}

function assertQuery(target, rules, required = []) {
  for (const name of target.searchParams.keys()) {
    if (!(name in rules) || target.searchParams.getAll(name).length !== 1) {
      throw new BrokerRequestError(`Query parameter ${name} is not allowed.`);
    }
  }
  for (const name of required) {
    if (!target.searchParams.has(name)) throw new BrokerRequestError(`Query parameter ${name} is required.`);
  }
  for (const [name, kind] of Object.entries(rules)) {
    const value = target.searchParams.get(name);
    if (value === null) continue;
    if (kind === 'versions' && value !== 'versions') throw new BrokerRequestError(`Query parameter ${name} is invalid.`);
    if (kind === 'version' && !/^\d+$/.test(value)) throw new BrokerRequestError(`Query parameter ${name} is invalid.`);
    if (kind === 'limit' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)) {
      throw new BrokerRequestError(`Query parameter ${name} is invalid.`);
    }
    if (kind === 'boolean' && value !== '1') throw new BrokerRequestError(`Query parameter ${name} is invalid.`);
  }
}

function parsedJsonBody(body) {
  if (typeof body !== 'string') throw new BrokerRequestError('A JSON request body is required.');
  try {
    return JSON.parse(body);
  } catch {
    throw new BrokerRequestError('Outbound request body must be valid JSON.');
  }
}

function assertNoteCreationBody(body) {
  const value = parsedJsonBody(body);
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new BrokerRequestError('Zotero note creation requires a bounded JSON array.');
  }
  for (const note of value) {
    const keys = note && typeof note === 'object' && !Array.isArray(note) ? Object.keys(note) : [];
    if (
      !keys.every((key) => ['itemType', 'parentItem', 'note'].includes(key))
      || note.itemType !== 'note'
      || typeof note.parentItem !== 'string'
      || !/^[A-Za-z0-9]{1,32}$/.test(note.parentItem)
      || typeof note.note !== 'string'
      || note.note.length > 500_000
    ) {
      throw new BrokerRequestError('Only child-note creation is allowed.');
    }
  }
}

function assertItemPatchBody(body) {
  const value = parsedJsonBody(body);
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  if (keys.length !== 1 || !['note', 'tags'].includes(keys[0])) {
    throw new BrokerRequestError('Only Zotero note or tag updates are allowed.');
  }
  if (keys[0] === 'note') {
    if (typeof value.note !== 'string' || value.note.length > 500_000) {
      throw new BrokerRequestError('The Zotero note update is invalid.');
    }
    return;
  }
  if (!Array.isArray(value.tags) || value.tags.length > 100 || value.tags.some((entry) => {
    const entryKeys = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry) : [];
    return entryKeys.length !== 1 || entryKeys[0] !== 'tag' || typeof entry.tag !== 'string' || entry.tag.length > 256;
  })) {
    throw new BrokerRequestError('The Zotero tag update is invalid.');
  }
}

async function readResponseBody(response) {
  const advertisedLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new BrokerRequestError('Zotero response is too large.', 502);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BrokerRequestError('Zotero response is too large.', 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchWithTimeout(fetchImpl, target, options) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(target, { ...options, redirect: 'manual', signal: abortController.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function selectedResponseHeaders(headers) {
  const selected = {};
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) selected[name] = value;
  }
  return selected;
}

function redactSecret(value, secret) {
  return secret ? value.split(secret).join('[redacted]') : value;
}

function isJsonContentType(value) {
  return typeof value === 'string' && value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

/**
 * Starts the desktop-only capability broker. The returned URL is deliberately
 * loopback-only; callers must supply the randomly generated bearer token.
 */
export async function startZoteroBroker({ token, getApiKey, host = '127.0.0.1', fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A strong broker token is required.');
  if (typeof getApiKey !== 'function') throw new Error('A credential provider is required.');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://${host}`);
      if (request.method !== 'POST' || requestUrl.pathname !== BROKER_PATH) {
        writeJson(response, 404, { error: 'Not found.' });
        return;
      }
      if (!equalsBearerToken(request.headers.authorization, token)) {
        writeJson(response, 401, { error: 'Unauthorized.' });
        return;
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        writeJson(response, 415, { error: 'The broker accepts application/json only.' });
        return;
      }

      const requestText = await readRequestBody(request);
      let requestPayload;
      try {
        requestPayload = JSON.parse(requestText);
      } catch {
        throw new BrokerRequestError('Request body must be valid JSON.');
      }
      const outbound = parseBrokerRequest(requestPayload);

      let apiKey;
      try {
        apiKey = await getApiKey();
      } catch {
        apiKey = undefined;
      }
      if (typeof apiKey !== 'string' || apiKey.length === 0) {
        writeJson(response, 503, { error: 'Zotero credentials are unavailable.' });
        return;
      }

      const upstreamHeaders = new Headers(outbound.headers);
      upstreamHeaders.set('zotero-api-key', apiKey);
      upstreamHeaders.set('zotero-api-version', '3');
      upstreamHeaders.set('user-agent', 'Rigorium Zotero Desktop Broker');

      let upstream;
      try {
        if (outbound.method === 'DELETE') {
          const inspectionHeaders = new Headers({
            'zotero-api-key': apiKey,
            'zotero-api-version': '3',
            'user-agent': 'Rigorium Zotero Desktop Broker',
          });
          const inspection = await fetchWithTimeout(fetchImpl, outbound.target, {
            method: 'GET',
            headers: inspectionHeaders,
          });
          const inspectionBody = redactSecret(await readResponseBody(inspection), apiKey);
          if (!inspection.ok) {
            writeJson(response, inspection.status, {
              status: inspection.status,
              headers: selectedResponseHeaders(inspection.headers),
              body: inspectionBody,
            });
            return;
          }
          let inspectedItem;
          try {
            inspectedItem = JSON.parse(inspectionBody);
          } catch {
            throw new BrokerRequestError('Zotero returned an invalid item record.', 502);
          }
          if (inspectedItem?.data?.itemType !== 'note') {
            throw new BrokerRequestError('Only Zotero notes can be deleted through this broker.', 403);
          }
        }
        upstream = await fetchWithTimeout(fetchImpl, outbound.target, {
          method: outbound.method,
          headers: upstreamHeaders,
          body: outbound.body,
        });
      } catch (error) {
        if (error instanceof BrokerRequestError) throw error;
        writeJson(response, 502, { error: 'Unable to reach Zotero.' });
        return;
      }

      const body = redactSecret(await readResponseBody(upstream), apiKey);
      writeJson(response, upstream.status, {
        status: upstream.status,
        headers: selectedResponseHeaders(upstream.headers),
        body,
      });
    } catch (error) {
      if (error instanceof BrokerRequestError) {
        writeJson(response, error.status, { error: error.message });
        return;
      }
      writeJson(response, 500, { error: 'The Zotero broker could not complete the request.' });
    }
  });
  server.keepAliveTimeout = 1_000;

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('The Zotero broker did not receive a TCP address.');
  }

  return {
    server,
    url: `http://${host}:${address.port}${BROKER_PATH}`,
  };
}
