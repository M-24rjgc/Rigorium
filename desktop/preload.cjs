const { contextBridge, ipcRenderer } = require('electron');

const STATUS_CHANNEL = 'rigorium:zotero-credentials:status';
const SAVE_CHANNEL = 'rigorium:zotero-credentials:save';
const CLEAR_CHANNEL = 'rigorium:zotero-credentials:clear';
const CLOUD_STATUS_CHANNEL = 'rigorium:zotero-cloud:status';
const CLOUD_SYNC_CHANNEL = 'rigorium:zotero-cloud:sync';
const CLOUD_PREVIEW_CHANNEL = 'rigorium:zotero-cloud:preview';
const CLOUD_CONFIRM_CHANNEL = 'rigorium:zotero-cloud:confirm';
const LIBRARY_IMPORT_CHANNEL = 'rigorium:zotero-library:import';

function isTrustedAppDocument() {
  try {
    const url = new URL(globalThis.location.href);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function invokeFromTrustedDocument(channel, ...args) {
  if (!isTrustedAppDocument()) return Promise.reject(new Error('Zotero access is unavailable in this document.'));
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld(
  'rigoriumZoteroCredentials',
  Object.freeze({
    status: () => invokeFromTrustedDocument(STATUS_CHANNEL),
    save: (apiKey) => invokeFromTrustedDocument(SAVE_CHANNEL, apiKey),
    clear: (options) => invokeFromTrustedDocument(CLEAR_CHANNEL, { confirmed: options?.confirmed === true }),
  }),
);

contextBridge.exposeInMainWorld(
  'rigoriumZoteroCloud',
  Object.freeze({
    status: (options) => invokeFromTrustedDocument(CLOUD_STATUS_CHANNEL, options),
    sync: (options) => invokeFromTrustedDocument(CLOUD_SYNC_CHANNEL, options),
    preview: (intent, options) => invokeFromTrustedDocument(CLOUD_PREVIEW_CHANNEL, intent, options),
    confirm: (plan, options) => invokeFromTrustedDocument(CLOUD_CONFIRM_CHANNEL, plan, options),
  }),
);

contextBridge.exposeInMainWorld(
  'rigoriumZoteroLibrary',
  Object.freeze({
    importPapers: (papers, options) => invokeFromTrustedDocument(LIBRARY_IMPORT_CHANNEL, papers, options),
  }),
);
