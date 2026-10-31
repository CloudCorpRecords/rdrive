'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { Files } = require('../lib/files');
const { OCRStore } = require('../lib/smart_search');
const { WatcherManager } = require('../lib/watchers');

test('watchers: pipeline rules, pattern matching, and upload event triggers', async () => {
  const tmp = path.join(os.tmpdir(), `rdrive-watchers-test-${Date.now()}`);
  const user = 'watcheruser';
  const files = new Files(tmp);
  const ocr = new OCRStore(tmp);
  const watchers = new WatcherManager(tmp, ocr);

  // 1. Initial default rules
  const list = watchers.getWatchers(user);
  assert.ok(list.length >= 2);
  assert.ok(list.some((w) => w.id === 'w-ocr'));
  assert.ok(list.some((w) => w.id === 'w-expenses'));

  // 2. Pattern matching
  assert.strictEqual(watchers.matchesPattern('/Backups/Phone/DCIM/photo.jpg', '/Backups/**'), true);
  assert.strictEqual(watchers.matchesPattern('/Docs/notes.txt', '/Backups/**'), false);
  assert.strictEqual(watchers.matchesPattern('/Receipts/Uber_14.50.pdf', '/Receipts/**'), true);

  // 3. Trigger on upload for OCR
  const triggered1 = await watchers.onUpload(files, user, '/Backups/Galaxy S25/DCIM/Screenshot_20261025_Claude.jpg', 'Screenshot_20261025_Claude.jpg');
  assert.strictEqual(triggered1.length, 1);
  assert.strictEqual(triggered1[0].action, 'ocr_index');

  // Verify OCR store got the hint
  const ocrText = ocr.getOCRText(user, '/Backups/Galaxy S25/DCIM/Screenshot_20261025_Claude.jpg', 'Screenshot_20261025_Claude.jpg');
  assert.ok(ocrText.toLowerCase().includes('claude'));

  // 4. Trigger on upload for Expenses
  const triggered2 = await watchers.onUpload(files, user, '/Receipts/Target_45.20.pdf', 'Target_45.20.pdf');
  assert.strictEqual(triggered2.length, 1);
  assert.strictEqual(triggered2[0].action, 'sheet_append');
  assert.strictEqual(triggered2[0].target, '/Finance/Expenses.rsheet');
  assert.strictEqual(triggered2[0].extracted.amount, '45.20');
  assert.strictEqual(triggered2[0].extracted.vendor, 'Target_45.20');

  await fsp.rm(tmp, { recursive: true, force: true });
});
