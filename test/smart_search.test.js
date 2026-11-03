'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { Files } = require('../lib/files');
const { OCRStore, smartSearch } = require('../lib/smart_search');

test('smart search: matches filenames, document contents, and visual OCR text', async () => {
  const tmp = path.join(os.tmpdir(), `rdrive-search-test-${Date.now()}`);
  const user = 'searchuser';
  const files = new Files(tmp);
  const ocr = new OCRStore(tmp);
  const userDir = files.userRoot(user);

  // 1. Direct filename
  await fsp.writeFile(path.join(userDir, 'project-roadmap.pdf'), 'roadmap pdf');

  // 2. RDocs document with embedded content
  const rdocPayload = JSON.stringify({
    format: 'rdrive-doc',
    version: 1,
    html: '<h1>Annual Agreement</h1><p>The contract termination clause requires 30 days written notice.</p>',
  });
  await fsp.writeFile(path.join(userDir, 'nda.rdoc'), rdocPayload);

  // 3. Plaintext note
  await fsp.writeFile(path.join(userDir, 'notes.md'), '# Meeting\nDiscussing quarterly budget allocation for 2027.');

  // 4. Image with OCR cache
  await fsp.writeFile(path.join(userDir, 'receipt_01.jpg'), 'fake-image');
  ocr.setOCRText(user, '/receipt_01.jpg', 'Home Depot Invoice #9842 Total $148.50 Plumbing Supplies');

  // Test 1: Filename search
  const res1 = await smartSearch(files, ocr, user, 'roadmap');
  assert.strictEqual(res1.length, 1);
  assert.strictEqual(res1[0].matchType, 'filename');
  assert.strictEqual(res1[0].name, 'project-roadmap.pdf');

  // Test 2: Document content search inside .rdoc
  const res2 = await smartSearch(files, ocr, user, 'termination clause');
  assert.strictEqual(res2.length, 1);
  assert.strictEqual(res2[0].matchType, 'document');
  assert.strictEqual(res2[0].name, 'nda.rdoc');
  assert.ok(res2[0].snippet.includes('termination clause'));

  // Test 3: OCR visual text search inside photo
  const res3 = await smartSearch(files, ocr, user, 'plumbing');
  assert.strictEqual(res3.length, 1);
  assert.strictEqual(res3[0].matchType, 'ocr');
  assert.strictEqual(res3[0].name, 'receipt_01.jpg');
  assert.ok(res3[0].snippet.includes('Plumbing Supplies'));

  // Test 4: Synonym search ("receipt" matches "invoice")
  const res4 = await smartSearch(files, ocr, user, 'receipt');
  assert.ok(res4.length >= 1);
  assert.ok(res4.some((r) => r.name === 'receipt_01.jpg'));

  await fsp.rm(tmp, { recursive: true, force: true });
});
