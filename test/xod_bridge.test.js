const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Files } = require('../lib/files');
const { VaultManager } = require('../lib/vault');
const { XodBridge, RDRIVE_TOOLS, extractTextToolCalls } = require('../lib/xod_bridge');

test('xod bridge: tool definitions, execution of drive/doc/code/storage tools', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-xod-test-'));
  try {
    const files = new Files(tmp);
    const vault = new VaultManager(tmp);
    const user = 'alice';

    const bridge = new XodBridge({ files, vault });

    assert.ok(Array.isArray(RDRIVE_TOOLS));
    assert.ok(RDRIVE_TOOLS.some(t => t.function.name === 'doc_write'));
    assert.ok(RDRIVE_TOOLS.some(t => t.function.name === 'storage_analytics'));

    // 1. Tool execution: doc_write and doc_read
    const writeRes = await bridge.executeTool(user, 'doc_write', {
      path: '/Notes/Idea.rdoc',
      markdown: '# Project Idea\n\nAI agent harness for RDrive.'
    });
    assert.equal(writeRes.ok, true);

    const readRes = await bridge.executeTool(user, 'doc_read', { path: '/Notes/Idea.rdoc' });
    assert.ok(readRes.markdown.includes('Project Idea'));

    // 2. Tool execution: code_save and code_read
    const codeWrite = await bridge.executeTool(user, 'code_save', {
      path: '/script.py',
      content: 'print("Hello from Xod")'
    });
    assert.equal(codeWrite.ok, true);

    const codeRead = await bridge.executeTool(user, 'code_read', { path: '/script.py' });
    assert.equal(codeRead.content, 'print("Hello from Xod")');

    // 3. Tool execution: drive_list
    const listRes = await bridge.executeTool(user, 'drive_list', { path: '/' });
    assert.ok(listRes.count >= 1);

    // 4. Tool execution: sheet_create
    const sheetRes = await bridge.executeTool(user, 'sheet_create', {
      path: '/budget.rsheet',
      rows: [['Category', 'Amount'], ['Hosting', '20']]
    });
    assert.equal(sheetRes.ok, true);

    // 5. Tool execution: vault_status
    const vaultRes = await bridge.executeTool(user, 'vault_status', {});
    assert.equal(vaultRes.hasPin, false);

    // 6. getStatus() returns connected flag & tool list
    const status = await bridge.getStatus();
    assert.ok(status.tools.length >= 8);

    // 7. extractTextToolCalls fallback tests
    const samplePhoneOutput = '范冰\n{"name": "sheet_create", "arguments": {"path": "/Budget.rsheet", "rows": [["Month", "Income", "Expenses", "Savings"], ["January", 3000, 1500, 1500]]}}\n</tool_call>';
    const calls1 = extractTextToolCalls(samplePhoneOutput);
    assert.equal(calls1.length, 1);
    assert.equal(calls1[0].function.name, 'sheet_create');
    const parsedArgs1 = JSON.parse(calls1[0].function.arguments);
    assert.equal(parsedArgs1.path, '/Budget.rsheet');
    assert.equal(parsedArgs1.rows.length, 2);

    const standardTag = '<tool_call>\n{"name": "drive_trash", "arguments": {"path": "/old.txt"}}\n</tool_call>';
    const calls2 = extractTextToolCalls(standardTag);
    assert.equal(calls2.length, 1);
    assert.equal(calls2[0].function.name, 'drive_trash');

    const codeBlock = '```json\n{"name": "storage_analytics", "arguments": {}}\n```';
    const calls3 = extractTextToolCalls(codeBlock);
    assert.equal(calls3.length, 1);
    assert.equal(calls3[0].function.name, 'storage_analytics');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
