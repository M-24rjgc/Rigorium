import assert from 'node:assert/strict';
import test from 'node:test';

import {
  localZoteroAttachmentPath,
  normalizeZoteroAttachmentKey,
  openZoteroAttachment,
} from './zotero-attachment.mjs';

test('the main-process attachment opener consumes a local URL without returning it', async () => {
  let requestedKey;
  let openedPath;
  const outcome = await openZoteroAttachment({
    attachmentKey: 'attach01',
    requestAttachment: async (key) => {
      requestedKey = key;
      return {
        available: true,
        fileUrl: 'file:///C:/Users/Ada/Zotero/storage/ATTACH01/paper.pdf',
      };
    },
    openPath: async (path) => {
      openedPath = path;
      return '';
    },
  });

  assert.equal(requestedKey, 'ATTACH01');
  assert.ok(openedPath);
  assert.notEqual(openedPath, 'file:///C:/Users/Ada/Zotero/storage/ATTACH01/paper.pdf');
  assert.deepEqual(outcome, { opened: true });
  assert.equal(JSON.stringify(outcome).includes('C:'), false);
});

test('the main-process attachment opener rejects invalid keys, unavailable files, and unsafe URLs', async () => {
  assert.throws(() => normalizeZoteroAttachmentKey('bad/key'), /attachment key is invalid/);
  assert.throws(() => localZoteroAttachmentPath('https://example.test/paper.pdf'), /unsafe attachment path/);
  assert.throws(() => localZoteroAttachmentPath('file://server/share/paper.pdf'), /unsafe attachment path/);
  assert.throws(() => localZoteroAttachmentPath('file:////server/share/paper.pdf'), /unsafe attachment path/);
  assert.throws(() => localZoteroAttachmentPath('file:///C:/paper.pdf?download=1'), /unsafe attachment path/);

  let opened = false;
  await assert.rejects(
    openZoteroAttachment({
      attachmentKey: 'ATTACH01',
      requestAttachment: async () => ({ available: false }),
      openPath: async () => {
        opened = true;
        return '';
      },
    }),
    /attachment is unavailable/,
  );
  assert.equal(opened, false);
});
