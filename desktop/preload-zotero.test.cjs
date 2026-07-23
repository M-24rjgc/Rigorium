const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

test('preload exposes attachment opening as a trusted IPC command without a file URL API', async () => {
  const exposed = {};
  const calls = [];
  const originalLoad = Module._load;
  const originalLocation = globalThis.location;
  const preloadPath = path.join(__dirname, 'preload.cjs');
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
        ipcRenderer: {
          invoke: async (...args) => {
            calls.push(args);
            return { opened: true };
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'http://127.0.0.1:43123/' },
  });

  try {
    delete require.cache[preloadPath];
    require(preloadPath);
    const library = exposed.rigoriumZoteroLibrary;
    assert.deepEqual(Object.keys(library).sort(), ['importPapers', 'openAttachment']);
    assert.equal('fileUrl' in library, false);
    assert.deepEqual(
      await library.openAttachment('ATTACH01', { projectPath: 'D:/project' }),
      { opened: true },
    );
    assert.deepEqual(calls, [[
      'rigorium:zotero-library:open-attachment',
      'ATTACH01',
      { projectPath: 'D:/project' },
    ]]);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
    if (originalLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation });
  }
});
