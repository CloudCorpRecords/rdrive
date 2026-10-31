// XOD Agent & Local Model Inference Bridge for RDrive.
// Connects RDrive (mobile and desktop) to Xod, LM Studio, and Ollama.
// Provides specialized RDrive control harness and autonomous tool execution.

const http = require('node:http');
const https = require('node:https');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { getStorageAnalytics } = require('./storage_cleanup');
const { markdownToRdoc, rdocToMarkdown } = require('./rdoc');

const RDRIVE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'drive_list',
      description: 'List files and folders in a directory of the user\'s drive.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path, e.g. "/" or "/Docs" or "/Backups"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drive_search',
      description: 'Search files across the drive by name, text contents, or visual OCR text.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term or keyword' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'storage_analytics',
      description: 'Get storage breakdown by category, duplicate file clusters, and potential savings.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clean_duplicates',
      description: 'Delete duplicate file copies identified by storage analytics to free up disk space.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'List of duplicate file paths to remove' },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'doc_read',
      description: 'Read an RDrive Document (.rdoc) as clean Markdown text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to .rdoc file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'doc_write',
      description: 'Create or update an RDrive Document (.rdoc) from Markdown formatted text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path where the .rdoc will be saved' },
          markdown: { type: 'string', description: 'Markdown content for the document' },
        },
        required: ['path', 'markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'code_read',
      description: 'Read the contents of a code or config file (.js, .py, .json, .sh, .css, .html, etc.).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'code_save',
      description: 'Save or edit code or config files directly in the drive.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'Text or code content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sheet_create',
      description: 'Create a new RDrive spreadsheet (.rsheet) with initial data rows and formulas.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path for the spreadsheet, e.g. /Expenses.rsheet' },
          rows: { type: 'array', description: '2D array of rows and columns' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vault_status',
      description: 'Check if the encrypted private vault is configured and whether it is currently unlocked.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drive_trash',
      description: 'Move a file or folder safely to the user\'s Trash.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to trash' },
        },
        required: ['path'],
      },
    },
  },
];

class XodBridge {
  constructor({ files, vault, shares = null, xodUrl = 'http://127.0.0.1:8000', lmStudioUrl = 'http://127.0.0.1:1234', ollamaUrl = 'http://127.0.0.1:11434' }) {
    this.files = files;
    this.vault = vault;
    this.shares = shares;
    this.xodUrl = xodUrl.replace(/\/+$/, '');
    this.lmStudioUrl = lmStudioUrl.replace(/\/+$/, '');
    this.ollamaUrl = ollamaUrl.replace(/\/+$/, '');
  }

  _httpRequest(targetUrl, options = {}, body = null) {
    return new Promise((resolve, reject) => {
      const u = new URL(targetUrl);
      const isHttps = u.protocol === 'https:';
      const mod = isHttps ? https : http;
      const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: options.method || 'GET',
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...options.headers,
        },
        timeout: options.timeout || 10000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, raw: data });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async getStatus() {
    const models = [];
    let xodOnline = false;
    let activeModel = null;
    let activeProvider = null;
    let baseUrl = null;

    // 1. Check Xod
    try {
      const xodRes = await this._httpRequest(`${this.xodUrl}/api/models`, { timeout: 1500 });
      if (xodRes.status === 200 && Array.isArray(xodRes.data?.models)) {
        xodOnline = true;
        for (const m of xodRes.data.models) {
          models.push({
            id: m.model,
            provider: m.provider || 'xod',
            name: `${m.model} (${m.server || 'Xod'})`,
            inUse: (m.in_use && m.in_use.length > 0) || false,
            context: m.context || null,
          });
          if (m.in_use?.includes('chat') && !activeModel) {
            activeModel = m.model;
            activeProvider = m.provider;
          }
        }
      }
    } catch {}

    // 2. Check LM Studio
    try {
      const lmRes = await this._httpRequest(`${this.lmStudioUrl}/v1/models`, { timeout: 1500 });
      if (lmRes.status === 200 && Array.isArray(lmRes.data?.data)) {
        for (const m of lmRes.data.data) {
          if (!models.some((x) => x.id === m.id)) {
            models.push({
              id: m.id,
              provider: 'lm_studio',
              name: `${m.id} (LM Studio)`,
              inUse: false,
            });
          }
          if (!activeModel) {
            activeModel = m.id;
            activeProvider = 'lm_studio';
            baseUrl = `${this.lmStudioUrl}/v1`;
          }
        }
      }
    } catch {}

    // 3. Check Ollama
    try {
      const olRes = await this._httpRequest(`${this.ollamaUrl}/api/tags`, { timeout: 1500 });
      if (olRes.status === 200 && Array.isArray(olRes.data?.models)) {
        for (const m of olRes.data.models) {
          const id = m.name || m.model;
          if (!models.some((x) => x.id === id)) {
            models.push({
              id,
              provider: 'ollama',
              name: `${id} (Ollama)`,
              inUse: false,
            });
          }
          if (!activeModel) {
            activeModel = id;
            activeProvider = 'ollama';
            baseUrl = `${this.ollamaUrl}/v1`;
          }
        }
      }
    } catch {}

    if (!baseUrl) {
      if (activeProvider === 'lm_studio') baseUrl = `${this.lmStudioUrl}/v1`;
      else if (activeProvider === 'ollama') baseUrl = `${this.ollamaUrl}/v1`;
      else if (xodOnline) baseUrl = this.xodUrl;
    }

    for (let i = models.length - 1; i >= 0; i--) if (/embed/i.test(models[i].id)) models.splice(i, 1);
    if (activeModel && /embed/i.test(activeModel)) activeModel = null;
    const pref = models.find((m) => /qwen2\.5/i.test(m.id)) || models[0];
    if (pref && (!activeModel || (pref !== models[0] && /qwen2\.5/i.test(pref.id)))) { activeModel = pref.id; activeProvider = pref.provider; }
    if (activeProvider === 'lm_studio') baseUrl = this.lmStudioUrl + '/v1';
    else if (activeProvider === 'ollama') baseUrl = this.ollamaUrl + '/v1';

    return {
      connected: models.length > 0,
      xodOnline,
      activeModel: activeModel || (models[0] ? models[0].id : null),
      activeProvider: activeProvider || (models[0] ? models[0].provider : null),
      baseUrl,
      models,
      tools: RDRIVE_TOOLS.map((t) => ({ name: t.function.name, description: t.function.description })),
    };
  }

  async executeTool(user, toolName, args = {}) {
    try {
      if (toolName === 'drive_list') {
        const p = args.path || '/';
        const entries = await this.files.list(user, p);
        return {
          path: p,
          count: entries.length,
          items: entries.slice(0, 50).map((e) => ({ name: e.name, type: e.type, size: e.size, modified: e.modified })),
        };
      }

      if (toolName === 'drive_search') {
        const query = args.query || '';
        const results = await this.files.search(user, query);
        return {
          query,
          count: results.length,
          matches: results.slice(0, 20).map((r) => ({ name: r.name, path: r.path, snippet: r.snippet, matchType: r.matchType })),
        };
      }

      if (toolName === 'storage_analytics') {
        const stats = await getStorageAnalytics(this.files, user);
        return {
          totalFiles: stats.totalFiles,
          totalBytes: stats.totalBytes,
          categories: stats.categories,
          duplicatesCount: stats.duplicates ? stats.duplicates.length : 0,
          potentialSavings: stats.duplicates ? stats.duplicates.reduce((acc, d) => acc + (d.potentialSavings || 0), 0) : 0,
          topDuplicates: (stats.duplicates || []).slice(0, 5),
          largeFiles: (stats.largeFiles || []).slice(0, 5),
        };
      }

      if (toolName === 'clean_duplicates') {
        const paths = Array.isArray(args.paths) ? args.paths : [];
        if (!paths.length) return { cleaned: 0, message: 'No paths provided' };
        await this.files.delete(user, paths);
        return { cleaned: paths.length, paths };
      }

      if (toolName === 'doc_read') {
        const p = args.path;
        if (!p) throw new Error('Path required');
        const full = this.files.resolve(user, p);
        const buf = await fsp.readFile(full);
        const data = JSON.parse(buf.toString('utf8'));
        const markdown = rdocToMarkdown(data);
        return { path: p, markdown, title: data.title || path.basename(p) };
      }

      if (toolName === 'doc_write') {
        const p = args.path;
        const md = args.markdown || '';
        if (!p) throw new Error('Path required');
        const rdoc = markdownToRdoc(md, { title: path.basename(p, '.rdoc') });
        const buf = Buffer.from(JSON.stringify(rdoc, null, 2), 'utf8');
        const dir = path.dirname(p).replace(/\\/g, '/');
        const name = path.basename(p);
        const segs = dir.split('/').filter(Boolean);
        let cur = '';
        for (const s of segs) {
          try { await this.files.mkdir(user, cur || '/', s); } catch {}
          cur += '/' + s;
        }
        await this.files.writeBuffer(user, dir || '/', name, buf, { overwrite: true });
        return { ok: true, path: p, bytes: buf.length };
      }

      if (toolName === 'code_read') {
        const p = args.path;
        if (!p) throw new Error('Path required');
        const full = this.files.resolve(user, p);
        const buf = await fsp.readFile(full);
        return { path: p, content: buf.toString('utf8'), size: buf.length };
      }

      if (toolName === 'code_save') {
        const p = args.path;
        const content = String(args.content || '');
        if (!p) throw new Error('Path required');
        const dir = path.dirname(p).replace(/\\/g, '/');
        const name = path.basename(p);
        const segs = dir.split('/').filter(Boolean);
        let cur = '';
        for (const s of segs) {
          try { await this.files.mkdir(user, cur || '/', s); } catch {}
          cur += '/' + s;
        }
        const buf = Buffer.from(content, 'utf8');
        await this.files.writeBuffer(user, dir || '/', name, buf, { overwrite: true });
        return { ok: true, path: p, size: buf.length };
      }

      if (toolName === 'sheet_create') {
        const p = args.path;
        const rows = args.rows || [];
        if (!p) throw new Error('Path required');
        const sheetData = {
          version: 1,
          title: path.basename(p, '.rsheet'),
          sheets: [
            {
              id: 'sheet1',
              name: 'Sheet 1',
              rows: rows.map((r) => (Array.isArray(r) ? r : [r])),
            },
          ],
        };
        const buf = Buffer.from(JSON.stringify(sheetData, null, 2), 'utf8');
        const dir = path.dirname(p).replace(/\\/g, '/');
        const name = path.basename(p);
        const segs = dir.split('/').filter(Boolean);
        let cur = '';
        for (const s of segs) {
          try { await this.files.mkdir(user, cur || '/', s); } catch {}
          cur += '/' + s;
        }
        await this.files.writeBuffer(user, dir || '/', name, buf, { overwrite: true });
        return { ok: true, path: p, rows: rows.length };
      }

      if (toolName === 'vault_status') {
        const hasPin = this.vault ? this.vault.hasPin(user) : false;
        return { hasPin, status: hasPin ? 'Protected' : 'Not configured' };
      }

      if (toolName === 'drive_trash') {
        const p = args.path;
        if (!p) throw new Error('Path required');
        await this.files.trash(user, p);
        return { ok: true, trashed: p };
      }

      return { error: `Unknown tool: ${toolName}` };
    } catch (err) {
      return { error: err.message };
    }
  }

  async runAgentTurn({ user, messages, model = null, onEvent = () => {} }) {
    const status = await this.getStatus();
    if (!status.connected) {
      throw new Error('No local AI inference engine connected (checked Xod, LM Studio, Ollama).');
    }

    const selectedModel = model || status.activeModel;
    let endpoint = status.baseUrl || `${this.lmStudioUrl}/v1`;
    if (selectedModel && selectedModel.includes('qwen') && !endpoint.includes('11434')) {
      endpoint = `${this.ollamaUrl}/v1`;
    }

    const systemPrompt = `You are Xod, a private and capable AI agent connected directly to RDrive.
You have real-time access to the user's files, documents (.rdoc), spreadsheets (.rsheet), code files, backups, and storage cleaner.
When the user asks you to perform tasks (e.g. check storage, clean duplicate files, find documents, write an RDoc, create a spreadsheet, edit code), use the available tools.
Keep your responses helpful, concise, and confirm completed actions.`;

    const convMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    onEvent({ type: 'status', message: `Connected to ${selectedModel}` });

    // Multi-turn agent loop with tool execution
    let iterations = 0;
    while (iterations < 5) {
      iterations++;
      const payload = {
        model: selectedModel,
        messages: convMessages,
        tools: RDRIVE_TOOLS,
        tool_choice: 'auto',
        temperature: 0.2,
      };

      const res = await this._httpRequest(`${endpoint}/chat/completions`, { method: 'POST', timeout: 300000 }, payload);
      if (res.status !== 200 || !res.data) {
        throw new Error(`Inference engine returned HTTP ${res.status}: ${JSON.stringify(res.data || res.raw)}`);
      }

      const choice = res.data.choices?.[0];
      if (!choice) throw new Error('No response choices returned by model');

      const msg = choice.message || {};
      if (msg.reasoning_content) {
        onEvent({ type: 'reasoning', content: msg.reasoning_content });
      }

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length > 0) {
        convMessages.push(msg);
        for (const tc of toolCalls) {
          const fnName = tc.function?.name;
          let fnArgs = {};
          try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}

          onEvent({ type: 'tool_call', name: fnName, args: fnArgs });
          const result = await this.executeTool(user, fnName, fnArgs);
          onEvent({ type: 'tool_result', name: fnName, result });

          convMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: fnName,
            content: JSON.stringify(result),
          });
        }
      } else {
        const text = msg.content || '';
        onEvent({ type: 'content', content: text });
        return {
          role: 'assistant',
          content: text,
          model: selectedModel,
        };
      }
    }

    return {
      role: 'assistant',
      content: 'Agent turn completed maximum steps.',
      model: selectedModel,
    };
  }
}

module.exports = { XodBridge, RDRIVE_TOOLS };
