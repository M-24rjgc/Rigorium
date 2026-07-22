import fetch from 'node-fetch';
import { timingSafeEqual } from 'node:crypto';

const MAX_BROKER_RESPONSE_CHARS = 2 * 1024 * 1024;
let desktopBrokerConfig;

export function configureDesktopZoteroCloudTransport(config) {
  if (desktopBrokerConfig) throw new Error('The desktop Zotero broker is already configured.');
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('A desktop Zotero broker configuration is required.');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(config.url);
  } catch {
    throw new Error('The desktop Zotero broker URL is invalid.');
  }
  if (
    parsedUrl.protocol !== 'http:'
    || parsedUrl.hostname !== '127.0.0.1'
    || !parsedUrl.port
    || parsedUrl.pathname !== '/v1/zotero/request'
    || parsedUrl.search
    || parsedUrl.hash
    || typeof config.token !== 'string'
    || config.token.length < 32
  ) {
    throw new Error('The desktop Zotero broker configuration is invalid.');
  }
  if (typeof config.routeToken !== 'string' || config.routeToken.length < 32) {
    throw new Error('The desktop Zotero cloud route token is invalid.');
  }
  desktopBrokerConfig = Object.freeze({ url: parsedUrl.href, token: config.token, routeToken: config.routeToken });
}

export function isAuthorizedDesktopZoteroCloudRequest(value) {
  const expected = desktopBrokerConfig?.routeToken;
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const receivedBuffer = Buffer.from(value, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * The UI server never receives a Zotero API key. In the desktop app it sends
 * relative Web API requests to the Electron main-process broker instead.
 */
export function createZoteroCloudTransport(options = {}) {
  const brokerUrl = options.brokerUrl ?? desktopBrokerConfig?.url;
  const brokerToken = options.brokerToken ?? desktopBrokerConfig?.token;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async request(input) {
      if (!brokerUrl || !brokerToken) {
        return { status: 503, body: { error: 'Secure Zotero cloud credentials are unavailable in this runtime.' } };
      }
      const response = await fetchImpl(brokerUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${brokerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: input.path,
          method: input.method,
          ...(input.headers ? { headers: input.headers } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        }),
      });
      const text = await readBoundedText(response);
      const payload = parseJson(text);
      if (!response.ok || !isBrokerResponse(payload)) {
        return {
          status: response.status,
          headers: responseHeaders(response.headers),
          body: payload ?? { error: 'The secure Zotero broker returned an invalid response.' },
        };
      }
      return {
        status: payload.status,
        headers: payload.headers,
        body: parseJson(payload.body) ?? payload.body,
      };
    },
  };
}

async function readBoundedText(response) {
  const text = await response.text();
  if (text.length > MAX_BROKER_RESPONSE_CHARS) {
    throw new Error('The secure Zotero broker returned an oversized response.');
  }
  return text;
}

function parseJson(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isBrokerResponse(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Number.isInteger(value.status)
    && value.status >= 100
    && value.status <= 599
    && typeof value.body === 'string';
}

function responseHeaders(headers) {
  return Object.fromEntries([...headers.entries()].map(([name, value]) => [name.toLowerCase(), value]));
}
