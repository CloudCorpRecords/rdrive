const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { Auth } = require('../lib/auth');
const { Files } = require('../lib/files');
const { createHandler } = require('../server');

let server;
let base;
let dataDir;
let aliceCookie = '';
let bobCookie = '';
let aliceWriteToken = '';
let aliceReadOnlyToken = '';
let aliceScopedToken = '';
let bobToken = '';

async function apiReq(method, url, { body, raw, cookie = aliceCookie } = {}) {
  const headers = { 'X-Rdrive': '1' };
  if (cookie) headers.Cookie = cookie;
  let payload = raw;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') };
}

async function mcpRpc(token, method, params = {}, id = 1) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: token ? `Bearer ${token}` : '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function mcpTool(token, name, args = {}) {
  const { status, json } = await mcpRpc(token, 'tools/call', { name, arguments: args });
  assert.equal(status, 200);
  const block = json.result.content[0];
  let parsed = null;
  try {
    parsed = JSON.parse(block.text);
  } catch {}
  return { isError: json.result.isError, text: block.text, data: parsed };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-mcp-'));
  const auth = new Auth(dataDir);
  const files = new Files(dataDir);
  const handler = createHandler({ auth, files });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const setup = await apiReq('POST', '/api/setup', {
    body: { username: 'alice', password: 'alice-secret-password' },
    cookie: '',
  });
  assert.equal(setup.status, 200);
  aliceCookie = setup.setCookie.split(';')[0];

  auth.addUser('bob', 'bob-secret-password');
  const bobLogin = await apiReq('POST', '/api/login', {
    body: { username: 'bob', password: 'bob-secret-password' },
    cookie: '',
  });
  assert.equal(bobLogin.status, 200);
  bobCookie = bobLogin.setCookie.split(';')[0];
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('MCP requires a valid Personal Agent Token and stores only its SHA-256 hash on disk', async () => {
  const unauth = await mcpRpc('', 'initialize');
  assert.equal(unauth.status, 401);

  const bad = await mcpRpc('rdrive_pat_invalid_token_123', 'initialize');
  assert.equal(bad.status, 401);

  await apiReq('POST', '/api/mkdir', { body: { path: '/', name: 'AI Workspace' } });
  await apiReq('PUT', '/api/upload?path=/&name=alice-private.txt', { raw: 'Strictly private to Alice root' });

  const tWrite = await apiReq('POST', '/api/tokens', {
    body: { label: 'Alice Full Agent', scope: 'write', rootPath: '/', expiresInDays: 30 },
  });
  assert.equal(tWrite.status, 200);
  assert.match(tWrite.json.token, /^rdrive_pat_/);
  aliceWriteToken = tWrite.json.token;

  // Verify plaintext token is NEVER stored in tokens.json
  const rawTokensFile = fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8');
  assert.equal(rawTokensFile.includes(aliceWriteToken), false);

  const tRead = await apiReq('POST', '/api/tokens', {
    body: { label: 'Alice Reader', scope: 'read', rootPath: '/', expiresInDays: 30 },
  });
  aliceReadOnlyToken = tRead.json.token;

  const tScoped = await apiReq('POST', '/api/tokens', {
    body: { label: 'Alice Workspace Agent', scope: 'write', rootPath: '/AI Workspace', expiresInDays: 30 },
  });
  aliceScopedToken = tScoped.json.token;

  const tBob = await apiReq('POST', '/api/tokens', {
    body: { label: 'Bob Agent', scope: 'write', rootPath: '/', expiresInDays: 30 },
    cookie: bobCookie,
  });
  bobToken = tBob.json.token;
});

test('MCP initialize, tools/list, sheet creation, formula evaluation, and row appending', async () => {
  const init = await mcpRpc(aliceWriteToken, 'initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'rdrive-mcp');

  const tools = await mcpRpc(aliceWriteToken, 'tools/list');
  assert.ok(tools.json.result.tools.some((t) => t.name === 'sheet_create'));
  assert.ok(tools.json.result.tools.some((t) => t.name === 'sheet_update_cells'));

  // Create a spreadsheet via MCP with formulas
  const created = await mcpTool(aliceWriteToken, 'sheet_create', {
    path: '/AI Workspace/Metrics.rsheet',
    sheetName: 'Q4',
    cells: {
      A1: 'Item',
      B1: 'Cost',
      A2: 'Servers',
      B2: 100,
      A3: 'Bandwidth',
      B3: 50,
      B5: '=SUM(B2:B4)',
    },
  });
  assert.equal(created.isError, false);
  assert.equal(created.data.cells.B5.value, 150);

  // Append a row (A4="Storage", B4=25) and verify B5 (=SUM(B2:B4)) updates to 175!
  const appended = await mcpTool(aliceWriteToken, 'sheet_append_rows', {
    path: '/AI Workspace/Metrics.rsheet',
    sheetName: 'Q4',
    rows: [],
  });
  assert.equal(appended.isError, false);

  const updated = await mcpTool(aliceWriteToken, 'sheet_update_cells', {
    path: '/AI Workspace/Metrics.rsheet',
    sheetName: 'Q4',
    cells: { A4: 'Storage', B4: 25 },
  });
  assert.equal(updated.isError, false);
  assert.equal(updated.data.cells.B5.value, 175);
});

test('Per-individual security: Bob\'s agent token cannot read or search Alice\'s files or spreadsheets', async () => {
  const bobList = await mcpTool(bobToken, 'drive_list', { path: '/' });
  assert.equal(bobList.isError, false);
  assert.deepEqual(bobList.data.entries, []);

  const bobSearch = await mcpTool(bobToken, 'drive_search', { query: 'Metrics' });
  assert.deepEqual(bobSearch.data.results, []);

  const bobReadAlice = await mcpTool(bobToken, 'sheet_read', { path: '/AI Workspace/Metrics.rsheet' });
  assert.equal(bobReadAlice.isError, true);
  assert.match(bobReadAlice.text, /Not found/);
});

test('Per-token security: Read-only token can read spreadsheets but cannot write, update, or trash', async () => {
  const tools = await mcpRpc(aliceReadOnlyToken, 'tools/list');
  const names = tools.json.result.tools.map((t) => t.name);
  assert.equal(names.includes('sheet_read'), true);
  assert.equal(names.includes('drive_write_file'), false);
  assert.equal(names.includes('sheet_update_cells'), false);

  const readRes = await mcpTool(aliceReadOnlyToken, 'sheet_read', { path: '/AI Workspace/Metrics.rsheet' });
  assert.equal(readRes.isError, false);
  assert.equal(readRes.data.cells.B5.value, 175);

  const writeAttempt = await mcpTool(aliceReadOnlyToken, 'drive_write_file', {
    path: '/hacked.txt',
    content: 'nope',
  });
  assert.equal(writeAttempt.isError, true);
  assert.match(writeAttempt.text, /read-only/);

  const trashAttempt = await mcpTool(aliceReadOnlyToken, 'drive_trash', {
    path: '/alice-private.txt',
  });
  assert.equal(trashAttempt.isError, true);
  assert.match(trashAttempt.text, /read-only/);
});

test('Per-token security: Folder-confined token (/AI Workspace) cannot access files outside its folder', async () => {
  // Listing "/" with the scoped token lists "/AI Workspace", not Alice's root "/"
  const listRoot = await mcpTool(aliceScopedToken, 'drive_list', { path: '/' });
  assert.equal(listRoot.isError, false);
  assert.deepEqual(
    listRoot.data.entries.map((e) => e.name),
    ['Metrics.rsheet']
  );

  // Search only returns matches inside /AI Workspace, never /alice-private.txt
  const searchPrivate = await mcpTool(aliceScopedToken, 'drive_search', { query: 'alice-private' });
  assert.deepEqual(searchPrivate.data.results, []);

  // Attempting to read /alice-private.txt looks for /AI Workspace/alice-private.txt (404)
  const readOutside = await mcpTool(aliceScopedToken, 'drive_read_file', { path: '/alice-private.txt' });
  assert.equal(readOutside.isError, true);

  // Attempting path traversal /../alice-private.txt is rejected
  const traversal = await mcpTool(aliceScopedToken, 'drive_read_file', { path: '/../alice-private.txt' });
  assert.equal(traversal.isError, true);
  assert.match(traversal.text, /Invalid name/);

  // Writing "/summary.md" with the scoped token writes inside "/AI Workspace/summary.md"
  const writeInside = await mcpTool(aliceScopedToken, 'drive_write_file', {
    path: '/summary.md',
    content: '# Q4 Metrics Summary\nTotal: $175',
  });
  assert.equal(writeInside.isError, false);
  assert.equal(fs.existsSync(path.join(dataDir, 'files', 'alice', 'AI Workspace', 'summary.md')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'files', 'alice', 'summary.md')), false);
});

test('Stdio MCP entrypoint (mcp.js) works end-to-end and token revocation takes effect immediately', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.js')], {
    env: { ...process.env, RDRIVE_URL: base, RDRIVE_TOKEN: aliceScopedToken },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const replyLine = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('\n')) resolve(buf.split('\n')[0]);
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'drive_read_file', arguments: { path: '/summary.md' } } }) + '\n');
  });
  child.kill();

  const parsed = JSON.parse(replyLine);
  assert.equal(parsed.id, 42);
  const content = JSON.parse(parsed.result.content[0].text);
  assert.match(content.content, /Total: \$175/);

  // Revoke aliceScopedToken and verify it is immediately rejected
  const listTokens = await apiReq('GET', '/api/tokens');
  const scopedRec = listTokens.json.tokens.find((t) => t.label === 'Alice Workspace Agent');
  assert.ok(scopedRec);
  const rev = await apiReq('POST', '/api/tokens/revoke', { body: { id: scopedRec.id } });
  assert.equal(rev.status, 200);

  const afterRevoke = await mcpRpc(aliceScopedToken, 'ping');
  assert.equal(afterRevoke.status, 401);
});

test('MCP RDocs tools: doc_write, doc_read, doc_append, and resource reading', async () => {
  const w = await mcpTool(aliceWriteToken, 'doc_write', {
    path: '/Notes',
    markdown: '# Meeting Notes\n\n- Discussed roadmap\n- Next steps',
  });
  assert.equal(w.isError, false);
  assert.equal(w.data.name, 'Notes.rdoc');

  const r = await mcpTool(aliceReadOnlyToken, 'doc_read', { path: '/Notes' });
  assert.equal(r.isError, false);
  assert.ok(r.data.markdown.includes('# Meeting Notes'));
  assert.ok(r.data.markdown.includes('- Discussed roadmap'));

  const rf = await mcpTool(aliceReadOnlyToken, 'drive_read_file', { path: '/Notes.rdoc' });
  assert.equal(rf.isError, false);
  assert.equal(rf.data.type, 'document');
  assert.ok(rf.data.content.includes('# Meeting Notes'));

  const app = await mcpTool(aliceWriteToken, 'doc_append', {
    path: '/Notes.rdoc',
    markdown: '\n## Decisions\n\nApproved budget.',
  });
  assert.equal(app.isError, false);

  const r2 = await mcpTool(aliceReadOnlyToken, 'doc_read', { path: '/Notes.rdoc' });
  assert.ok(r2.data.markdown.includes('## Decisions'));
  assert.ok(r2.data.markdown.includes('Approved budget.'));

  const res = await mcpRpc(aliceReadOnlyToken, 'resources/read', { uri: 'rdrive:///Notes.rdoc' });
  assert.equal(res.status, 200);
  assert.equal(res.json.result.contents[0].mimeType, 'text/markdown');
  assert.ok(res.json.result.contents[0].text.includes('# Meeting Notes'));
});
