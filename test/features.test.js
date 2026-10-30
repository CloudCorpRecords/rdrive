const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test, before, after } = require('node:test');
const { Auth } = require('../lib/auth');
const { Files } = require('../lib/files');
const { createHandler } = require('../server');
const { evaluateWorkbook, parseDelimited, serializeDelimited, delimitedToWorkbook } = require('../public/sheet');

let server;
let base;
let dataDir;
let cookie = '';

async function req(method, url, { body, raw, headers = {}, auth = true } = {}) {
  const h = { 'X-Rdrive': '1', ...headers };
  if (auth && cookie) h.Cookie = cookie;
  let payload = raw;
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const setCookie = res.headers.get('set-cookie');
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text, buf, setCookie };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-feat-'));
  const handler = createHandler({ auth: new Auth(dataDir), files: new Files(dataDir) });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const setup = await req('POST', '/api/setup', {
    body: { username: 'alice', password: 'alice-strong-password' },
  });
  assert.equal(setup.status, 200);
  cookie = setup.setCookie.split(';')[0];
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('RDrive Sheets: formula engine evaluates math, ranges, IF, cross-sheet refs, and cycle detection', () => {
  const wb = {
    format: 'rdrive-sheet',
    version: 1,
    activeSheet: 0,
    sheets: [
      {
        name: 'Summary',
        cells: {
          A1: { v: 10 },
          A2: { v: 20 },
          A3: { v: 30 },
          B1: { v: '=SUM(A1:A3)' },
          B2: { v: '=AVERAGE(A1:A3)' },
          B3: { v: '=IF(B1>50, "On Track", "Low")' },
          B4: { v: '=ROUND(10/3, 2)' },
          B5: { v: '=CONCAT("Total: ", B1)' },
          B6: { v: '=Rates!A1 * B1' },
          C1: { v: '=C2' },
          C2: { v: '=C1' },
          D1: { v: '=1/0' },
          D2: { v: '=IFERROR(1/0, 99)' },
        },
      },
      {
        name: 'Rates',
        cells: {
          A1: { v: 1.5 },
        },
      },
    ],
  };

  const caches = evaluateWorkbook(wb);
  const s0 = caches[0];
  assert.equal(s0.get('B1'), 60);
  assert.equal(s0.get('B2'), 20);
  assert.equal(s0.get('B3'), 'On Track');
  assert.equal(s0.get('B4'), 3.33);
  assert.equal(s0.get('B5'), 'Total: 60');
  assert.equal(s0.get('B6'), 90);
  assert.equal(s0.get('C1'), '#CYCLE!');
  assert.equal(s0.get('D1'), '#DIV/0!');
  assert.equal(s0.get('D2'), 99);
});

test('RDrive Sheets: CSV parsing, serialization, and server creation', async () => {
  const csv = 'Item,Price,Notes\n"Apples, Organic",4.5,"Fresh ""local"" crop"\nBananas,2.25,Ripe\n';
  const rows = parseDelimited(csv, ',');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['Apples, Organic', '4.5', 'Fresh "local" crop']);

  const wb = delimitedToWorkbook(csv, 'Groceries.csv', ',');
  const roundTrip = serializeDelimited(wb.sheets[0], ',');
  assert.equal(roundTrip, csv);

  const created = await req('POST', '/api/sheet/create', {
    body: { path: '/', name: 'Q4 Budget.rsheet' },
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.name, 'Q4 Budget.rsheet');
  assert.equal(created.json.path, '/Q4 Budget.rsheet');

  const dl = await req('GET', '/api/download?path=/Q4%20Budget.rsheet&inline=1');
  assert.equal(dl.status, 200);
  assert.equal(dl.json.format, 'rdrive-sheet');
});

test('Search and Copy across nested folders', async () => {
  await req('POST', '/api/mkdir', { body: { path: '/', name: 'Projects' } });
  await req('PUT', '/api/upload?path=/Projects&name=roadmap-2026.txt', { raw: 'launch rdrive sheets' });

  const searchRes = await req('GET', '/api/search?q=roadmap');
  assert.equal(searchRes.status, 200);
  assert.equal(searchRes.json.results.length, 1);
  assert.equal(searchRes.json.results[0].path, '/Projects/roadmap-2026.txt');
  assert.equal(searchRes.json.results[0].dir, '/Projects');

  const copyRes = await req('POST', '/api/copy', {
    body: { from: '/Projects/roadmap-2026.txt', to: '/Projects/roadmap-2026 copy.txt' },
  });
  assert.equal(copyRes.status, 200);
  assert.equal(copyRes.json.name, 'roadmap-2026 copy.txt');
});

test('Trash view, restore to original folder, and empty trash', async () => {
  await req('POST', '/api/delete', { body: { paths: ['/Projects/roadmap-2026 copy.txt'] } });
  const trashList = await req('GET', '/api/trash');
  assert.equal(trashList.status, 200);
  assert.equal(trashList.json.items.length, 1);
  const item = trashList.json.items[0];
  assert.equal(item.name, 'roadmap-2026 copy.txt');
  assert.equal(item.originalDir, '/Projects');

  const restored = await req('POST', '/api/trash/restore', { body: { id: item.id } });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.restored.path, '/Projects/roadmap-2026 copy.txt');

  // Delete again and empty trash
  await req('POST', '/api/delete', { body: { paths: ['/Projects/roadmap-2026 copy.txt'] } });
  assert.equal((await req('GET', '/api/trash')).json.items.length, 1);
  assert.equal((await req('POST', '/api/trash/empty')).status, 200);
  assert.equal((await req('GET', '/api/trash')).json.items.length, 0);
});

test('Folder .zip download produces a valid PKZIP archive', async () => {
  const zipRes = await req('GET', '/api/zip?path=/Projects');
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');
  const buf = zipRes.buf;
  // Check Local File Header signature PK\x03\x04 and End of Central Directory PK\x05\x06
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  const nameLen = buf.readUInt16LE(26);
  const entryName = buf.subarray(30, 30 + nameLen).toString('utf8');
  assert.equal(entryName, 'Projects/roadmap-2026.txt');
  // Find data descriptor signature 0x08074b50
  const ddOffset = buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), 30 + nameLen);
  assert.ok(ddOffset > 30 + nameLen);
  const compressed = buf.subarray(30 + nameLen, ddOffset);
  const inflated = zlib.inflateRawSync(compressed).toString('utf8');
  assert.equal(inflated, 'launch rdrive sheets');
});

test('Share links: public, password-protected, editable spreadsheet, and revocation', async () => {
  // 1. Editable spreadsheet share
  const createSheetShare = await req('POST', '/api/shares', {
    body: { path: '/Q4 Budget.rsheet', expiresInHours: 24, allowEdit: true },
  });
  assert.equal(createSheetShare.status, 200);
  const shareId = createSheetShare.json.share.id;

  const pubInfo = await req('GET', `/api/public/share?id=${shareId}`, { auth: false });
  assert.equal(pubInfo.status, 200);
  assert.equal(pubInfo.json.locked, false);
  assert.equal(pubInfo.json.isSheet, true);
  assert.equal(pubInfo.json.allowEdit, true);

  const editedPayload = JSON.stringify({
    format: 'rdrive-sheet',
    version: 1,
    activeSheet: 0,
    sheets: [{ name: 'Sheet 1', rows: 20, cols: 10, cells: { A1: { v: 'Updated via share link' } } }],
  });
  const saveRes = await req('PUT', `/api/public/share/save?id=${shareId}`, { raw: editedPayload, auth: false });
  assert.equal(saveRes.status, 200);

  const verifyDl = await req('GET', `/api/public/share/download?id=${shareId}&inline=1`, { auth: false });
  assert.equal(verifyDl.json.sheets[0].cells.A1.v, 'Updated via share link');

  // 2. Password-protected share link
  const protectedShare = await req('POST', '/api/shares', {
    body: { path: '/Projects/roadmap-2026.txt', expiresInHours: 24, password: 'secret-share-pw' },
  });
  const pid = protectedShare.json.share.id;
  const lockedInfo = await req('GET', `/api/public/share?id=${pid}`, { auth: false });
  assert.equal(lockedInfo.json.locked, true);

  const deniedDl = await req('GET', `/api/public/share/download?id=${pid}`, { auth: false });
  assert.equal(deniedDl.status, 401);

  const badUnlock = await req('POST', '/api/public/share/unlock', {
    body: { id: pid, password: 'wrong' },
    auth: false,
  });
  assert.equal(badUnlock.status, 401);

  const okUnlock = await req('POST', '/api/public/share/unlock', {
    body: { id: pid, password: 'secret-share-pw' },
    auth: false,
  });
  assert.equal(okUnlock.status, 200);
  const shareCookie = okUnlock.setCookie.split(';')[0];

  const unlockedDl = await req('GET', `/api/public/share/download?id=${pid}`, {
    auth: false,
    headers: { Cookie: shareCookie },
  });
  assert.equal(unlockedDl.status, 200);
  assert.equal(unlockedDl.text, 'launch rdrive sheets');

  // 3. Revoke share
  assert.equal((await req('POST', '/api/shares/revoke', { body: { id: pid } })).status, 200);
  assert.equal((await req('GET', `/api/public/share?id=${pid}`, { auth: false })).status, 404);
});

test('WebDAV mount support (/dav/): PROPFIND, MKCOL, PUT, GET, MOVE, COPY, LOCK, DELETE', async () => {
  const noAuth = await fetch(base + '/dav/', { method: 'PROPFIND' });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate') || '', /Basic/);

  const basic = 'Basic ' + Buffer.from('alice:alice-strong-password').toString('base64');
  const davHeaders = { Authorization: basic };

  // A browser session cookie alone may read over WebDAV, but never write (CSRF protection).
  const cookieRead = await fetch(base + '/dav/', { method: 'PROPFIND', headers: { Cookie: cookie, Depth: '0' } });
  assert.equal(cookieRead.status, 207);
  const cookieWrite = await fetch(base + '/dav/csrf.txt', { method: 'PUT', headers: { Cookie: cookie }, body: 'x' });
  assert.equal(cookieWrite.status, 401);

  const opts = await fetch(base + '/dav/', { method: 'OPTIONS' });
  assert.equal(opts.status, 200);
  assert.match(opts.headers.get('dav') || '', /1,\s*2/);

  const prop = await fetch(base + '/dav/', { method: 'PROPFIND', headers: { ...davHeaders, Depth: '1' } });
  assert.equal(prop.status, 207);
  const propXml = await prop.text();
  assert.match(propXml, /Projects/);
  assert.match(propXml, /Q4%20Budget\.rsheet/);

  const mkcol = await fetch(base + '/dav/MountedFolder', { method: 'MKCOL', headers: davHeaders });
  assert.equal(mkcol.status, 201);

  const put = await fetch(base + '/dav/MountedFolder/notes.txt', {
    method: 'PUT',
    headers: davHeaders,
    body: 'written over webdav',
  });
  assert.equal(put.status, 201);

  const get = await fetch(base + '/dav/MountedFolder/notes.txt', { headers: davHeaders });
  assert.equal(await get.text(), 'written over webdav');

  const move = await fetch(base + '/dav/MountedFolder/notes.txt', {
    method: 'MOVE',
    headers: { ...davHeaders, Destination: base + '/dav/MountedFolder/renamed.txt' },
  });
  assert.equal(move.status, 201);

  const lock = await fetch(base + '/dav/MountedFolder/renamed.txt', { method: 'LOCK', headers: davHeaders });
  assert.equal(lock.status, 200);
  assert.match(lock.headers.get('lock-token') || '', /opaquelocktoken:/);

  const del = await fetch(base + '/dav/MountedFolder/renamed.txt', { method: 'DELETE', headers: davHeaders });
  assert.equal(del.status, 204);

  // Deleted WebDAV files go to Trash so they remain recoverable
  const trash = await req('GET', '/api/trash');
  assert.equal(trash.json.items.some((i) => i.name === 'renamed.txt'), true);
});
