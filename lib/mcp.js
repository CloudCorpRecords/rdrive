// Model Context Protocol (MCP) server for rdrive + RDrive Sheets.
// Enforces per-individual user isolation, read/write scopes, and optional subfolder confinement.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { HttpError, segments, validateName } = require('./files');
const { isSheetName } = require('./shares');
const {
  evaluateWorkbook,
  delimitedToWorkbook,
  serializeDelimited,
  colToLetter,
} = require('../public/sheet');

const PROTOCOL_VERSION = '2024-11-05';
const MAX_READ_BYTES = 512 * 1024; // 512 KB text read limit for agent context safety

const READ_TOOLS = [
  {
    name: 'drive_list',
    description: 'List files, folders, and spreadsheets in a folder of the user\'s RDrive.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder path to list (default "/")' },
      },
    },
  },
  {
    name: 'drive_search',
    description: 'Search recursively for files, folders, and spreadsheets by name in the user\'s RDrive.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive search substring' },
      },
      required: ['query'],
    },
  },
  {
    name: 'drive_read_file',
    description: 'Read the text contents of a file (e.g. .txt, .md, .json, .csv, .log) from the user\'s RDrive.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, e.g. "/notes.md"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sheet_read',
    description: 'Read an RDrive Spreadsheet (.rsheet, .csv, or .tsv), returning sheet tabs, raw formulas/values, and evaluated formula results.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the spreadsheet, e.g. "/Budget.rsheet" or "/data.csv"' },
        sheetName: { type: 'string', description: 'Optional sheet tab name (defaults to the active or first tab)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'drive_usage',
    description: 'Get total file count and storage byte usage for this user\'s RDrive.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const WRITE_TOOLS = [
  {
    name: 'drive_write_file',
    description: 'Create or update a text file (.txt, .md, .json, .csv, etc.) in the user\'s RDrive.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path of the file to write, e.g. "/Docs/summary.md"' },
        content: { type: 'string', description: 'Text content to write' },
        overwrite: { type: 'boolean', description: 'Overwrite if the file already exists (default true)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'drive_mkdir',
    description: 'Create a folder in the user\'s RDrive.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full folder path to create, e.g. "/Projects/2026"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'drive_move',
    description: 'Rename or move a file or folder within the user\'s RDrive.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path' },
        to: { type: 'string', description: 'Destination path' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'drive_copy',
    description: 'Duplicate a file, spreadsheet, or folder within the user\'s RDrive.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path' },
        to: { type: 'string', description: 'Destination path' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'drive_trash',
    description: 'Move a file or folder to the user\'s recoverable Trash (never permanently deletes).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file or folder to move to Trash' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sheet_create',
    description: 'Create a new RDrive Spreadsheet (.rsheet or .csv) with optional initial cells and formulas.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path for the new spreadsheet, e.g. "/Finance/Expenses.rsheet"' },
        sheetName: { type: 'string', description: 'Initial tab name (default "Sheet 1")' },
        cells: {
          type: 'object',
          description: 'Optional map of cell addresses (e.g. "A1", "B2") to values, formulas (e.g. "=SUM(B2:B10)"), or cell objects { v, b, i, fmt, align }',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'sheet_update_cells',
    description: 'Update cells, formulas, or formatting in an existing spreadsheet (.rsheet, .csv, or .tsv) and return the newly evaluated values.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the spreadsheet' },
        sheetName: { type: 'string', description: 'Optional tab name (if omitted, uses active sheet; if tab does not exist in .rsheet, creates it)' },
        cells: {
          type: 'object',
          description: 'Map of cell references ("A1", "C5") to values/formulas (string, number, null to clear, or object { v, b, i, u, fmt, align, bg, fg })',
        },
      },
      required: ['path', 'cells'],
    },
  },
  {
    name: 'sheet_append_rows',
    description: 'Append one or more rows of values/formulas after the last populated row of a spreadsheet (.rsheet or .csv).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the spreadsheet' },
        sheetName: { type: 'string', description: 'Optional sheet tab name' },
        rows: {
          type: 'array',
          description: 'Array of rows, where each row is an array of cell values/formulas, e.g. [["2026-10-30", "Coffee", 4.50]]',
          items: { type: 'array', items: {} },
        },
      },
      required: ['path', 'rows'],
    },
  },
  {
    name: 'drive_create_share',
    description: 'Create an expiring share link for a file, folder, or spreadsheet.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to share' },
        expiresInHours: { type: 'number', description: 'Expiration in hours (default 168 = 7 days, 0 = never)' },
        allowEdit: { type: 'boolean', description: 'For spreadsheets, allow anyone with the link to edit cells' },
        password: { type: 'string', description: 'Optional password to protect the link' },
      },
      required: ['path'],
    },
  },
];

// Map an agent-requested path into the user's drive, confined to the token's rootPath.
function resolveScopedPath(tokenInfo, rawPath = '/') {
  const baseSegs = segments(tokenInfo.rootPath || '/');
  const reqSegs = segments(rawPath || '/');
  // If the caller already prefixed rootPath, strip the duplicate prefix so both "/file" and "/rootPath/file" work cleanly.
  let relSegs = reqSegs;
  if (
    baseSegs.length > 0 &&
    reqSegs.length >= baseSegs.length &&
    baseSegs.every((seg, i) => reqSegs[i] === seg)
  ) {
    relSegs = reqSegs.slice(baseSegs.length);
  }
  return '/' + [...baseSegs, ...relSegs].join('/');
}

function toDisplayPath(tokenInfo, fullClientPath) {
  const base = '/' + segments(tokenInfo.rootPath || '/').join('/');
  if (base === '/') return fullClientPath;
  if (fullClientPath === base) return '/';
  if (fullClientPath.startsWith(base + '/')) return fullClientPath.slice(base.length);
  return fullClientPath;
}

async function loadWorkbookFromDisk(files, user, clientPath) {
  const file = await files.fileForDownload(user, clientPath);
  const raw = await fsp.readFile(file.full, 'utf8');
  const ext = path.extname(file.name).toLowerCase();
  const isDelimited = ext === '.csv' || ext === '.tsv';
  const sep = ext === '.tsv' ? '\t' : ',';
  let wb;
  if (isDelimited) {
    wb = delimitedToWorkbook(raw, file.name, sep);
  } else {
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : null;
      wb = parsed && Array.isArray(parsed.sheets) && parsed.sheets.length ? parsed : delimitedToWorkbook(raw, file.name, ',');
    } catch {
      wb = delimitedToWorkbook(raw, file.name, ',');
    }
  }
  return { wb, isDelimited, sep, name: file.name };
}

async function saveWorkbookToDisk(files, user, clientPath, wb, isDelimited, sep) {
  const segs = segments(clientPath);
  const fileName = segs.pop();
  const dirPath = '/' + segs.join('/');
  const payload = isDelimited
    ? serializeDelimited(wb.sheets[wb.activeSheet || 0], sep)
    : JSON.stringify(wb, null, 2);
  await files.writeBuffer(user, dirPath, fileName, Buffer.from(payload, 'utf8'), { overwrite: true });
}

function summarizeSheet(wb, sheetIdx = 0) {
  const caches = evaluateWorkbook(wb);
  const sheet = wb.sheets[sheetIdx];
  const cache = caches[sheetIdx] || new Map();
  const evaluatedCells = {};
  for (const [k, cell] of Object.entries(sheet.cells || {})) {
    if (cell && cell.v !== undefined && cell.v !== '') {
      evaluatedCells[k] = {
        raw: cell.v,
        value: cache.get(k),
        ...(cell.fmt ? { fmt: cell.fmt } : {}),
        ...(cell.b ? { bold: true } : {}),
      };
    }
  }
  return {
    activeSheet: sheet.name,
    sheets: wb.sheets.map((s) => s.name),
    rows: sheet.rows,
    cols: sheet.cols,
    cells: evaluatedCells,
  };
}

function normalizeCellPatch(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'object' && !Array.isArray(val)) {
    const out = {};
    if (val.v !== undefined) out.v = val.v;
    if (val.b || val.bold) out.b = 1;
    if (val.i || val.italic) out.i = 1;
    if (val.u || val.underline) out.u = 1;
    if (val.fmt) out.fmt = String(val.fmt);
    if (val.align) out.align = String(val.align);
    if (val.bg) out.bg = String(val.bg);
    if (val.fg) out.fg = String(val.fg);
    return out;
  }
  return { v: val };
}

async function ensureParentDirs(files, user, dirPath) {
  const segs = segments(dirPath);
  let cur = '/';
  for (const seg of segs) {
    const next = (cur === '/' ? '' : cur) + '/' + seg;
    const full = files.resolve(user, next);
    try {
      await fsp.mkdir(full);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    cur = next;
  }
}

class McpServer {
  constructor({ auth, files, shares, onChanged }) {
    this.auth = auth;
    this.files = files;
    this.shares = shares;
    this.onChanged = onChanged || (() => {});
  }

  toolsForScope(scope) {
    return scope === 'read' ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS];
  }

  async executeTool(tokenInfo, name, args = {}) {
    const user = tokenInfo.user;
    const isWriteTool = WRITE_TOOLS.some((t) => t.name === name);
    if (isWriteTool && tokenInfo.scope === 'read') {
      throw new HttpError(403, `This agent token is read-only and cannot call "${name}".`);
    }

    switch (name) {
      case 'drive_list': {
        const target = resolveScopedPath(tokenInfo, args.path || '/');
        const entries = await this.files.list(user, target);
        return { path: toDisplayPath(tokenInfo, target), entries };
      }
      case 'drive_search': {
        const all = await this.files.search(user, args.query);
        const base = '/' + segments(tokenInfo.rootPath || '/').join('/');
        const filtered = all
          .filter((r) => base === '/' || r.path === base || r.path.startsWith(base + '/'))
          .map((r) => ({
            ...r,
            path: toDisplayPath(tokenInfo, r.path),
            dir: toDisplayPath(tokenInfo, r.dir),
          }));
        return { results: filtered };
      }
      case 'drive_read_file': {
        const target = resolveScopedPath(tokenInfo, args.path);
        const file = await this.files.fileForDownload(user, target);
        if (file.size > MAX_READ_BYTES) {
          throw new HttpError(413, `File is ${file.size} bytes (exceeds 512 KB agent text read limit).`);
        }
        const content = await fsp.readFile(file.full, 'utf8');
        return { path: toDisplayPath(tokenInfo, target), name: file.name, size: file.size, modified: file.mtime.toISOString(), content };
      }
      case 'sheet_read': {
        const target = resolveScopedPath(tokenInfo, args.path);
        const { wb } = await loadWorkbookFromDisk(this.files, user, target);
        let idx = wb.activeSheet || 0;
        if (args.sheetName) {
          const found = wb.sheets.findIndex((s) => s.name.toLowerCase() === String(args.sheetName).toLowerCase());
          if (found < 0) throw new HttpError(404, `Sheet tab "${args.sheetName}" not found.`);
          idx = found;
        }
        return { path: toDisplayPath(tokenInfo, target), ...summarizeSheet(wb, idx) };
      }
      case 'drive_usage': {
        return await this.files.usage(user);
      }
      case 'drive_write_file': {
        const target = resolveScopedPath(tokenInfo, args.path);
        const segs = segments(target);
        if (!segs.length) throw new HttpError(400, 'File path required.');
        const fileName = segs.pop();
        const dirPath = '/' + segs.join('/');
        await ensureParentDirs(this.files, user, dirPath);
        const saved = await this.files.writeBuffer(user, dirPath, fileName, Buffer.from(String(args.content ?? ''), 'utf8'), {
          overwrite: args.overwrite !== false,
        });
        this.onChanged();
        const savedPath = (dirPath === '/' ? '' : dirPath) + '/' + saved;
        return { ok: true, name: saved, path: toDisplayPath(tokenInfo, savedPath) };
      }
      case 'drive_mkdir': {
        const target = resolveScopedPath(tokenInfo, args.path);
        await ensureParentDirs(this.files, user, target);
        this.onChanged();
        return { ok: true, path: toDisplayPath(tokenInfo, target) };
      }
      case 'drive_move': {
        const from = resolveScopedPath(tokenInfo, args.from);
        const to = resolveScopedPath(tokenInfo, args.to);
        await this.files.move(user, from, to);
        this.onChanged();
        return { ok: true, from: toDisplayPath(tokenInfo, from), to: toDisplayPath(tokenInfo, to) };
      }
      case 'drive_copy': {
        const from = resolveScopedPath(tokenInfo, args.from);
        const to = resolveScopedPath(tokenInfo, args.to);
        const savedName = await this.files.copy(user, from, to);
        this.onChanged();
        return { ok: true, name: savedName };
      }
      case 'drive_trash': {
        const target = resolveScopedPath(tokenInfo, args.path);
        const rootScoped = resolveScopedPath(tokenInfo, '/');
        if (target === rootScoped) throw new HttpError(400, 'Cannot trash root folder.');
        await this.files.trash(user, target);
        this.onChanged();
        return { ok: true, trashed: toDisplayPath(tokenInfo, target) };
      }
      case 'sheet_create': {
        let rawTarget = String(args.path || 'Untitled spreadsheet.rsheet');
        if (!isSheetName(rawTarget)) rawTarget += '.rsheet';
        const target = resolveScopedPath(tokenInfo, rawTarget);
        const segs = segments(target);
        const fileName = segs.pop();
        const dirPath = '/' + segs.join('/');
        await ensureParentDirs(this.files, user, dirPath);

        const ext = path.extname(fileName).toLowerCase();
        const isDelimited = ext === '.csv' || ext === '.tsv';
        const sep = ext === '.tsv' ? '\t' : ',';
        const cells = {};
        if (args.cells && typeof args.cells === 'object') {
          for (const [ref, val] of Object.entries(args.cells)) {
            const norm = normalizeCellPatch(val);
            if (norm) cells[String(ref).toUpperCase()] = norm;
          }
        }
        const wb = {
          format: 'rdrive-sheet',
          version: 1,
          activeSheet: 0,
          sheets: [
            {
              name: String(args.sheetName || 'Sheet 1'),
              rows: 50,
              cols: 16,
              colWidths: {},
              frozenRows: 1,
              cells,
            },
          ],
        };
        const payload = isDelimited ? serializeDelimited(wb.sheets[0], sep) : JSON.stringify(wb, null, 2);
        const savedName = await this.files.writeBuffer(user, dirPath, fileName, Buffer.from(payload, 'utf8'), { overwrite: false });
        this.onChanged();
        const finalPath = (dirPath === '/' ? '' : dirPath) + '/' + savedName;
        return { path: toDisplayPath(tokenInfo, finalPath), ...summarizeSheet(wb, 0) };
      }
      case 'sheet_update_cells': {
        const target = resolveScopedPath(tokenInfo, args.path);
        const { wb, isDelimited, sep } = await loadWorkbookFromDisk(this.files, user, target);
        let idx = wb.activeSheet || 0;
        if (args.sheetName) {
          let found = wb.sheets.findIndex((s) => s.name.toLowerCase() === String(args.sheetName).toLowerCase());
          if (found < 0) {
            if (isDelimited) throw new HttpError(400, 'CSV files only support a single sheet.');
            wb.sheets.push({ name: String(args.sheetName), rows: 50, cols: 16, colWidths: {}, frozenRows: 1, cells: {} });
            found = wb.sheets.length - 1;
          }
          idx = found;
        }
        const sheet = wb.sheets[idx];
        if (!sheet.cells) sheet.cells = {};
        for (const [ref, val] of Object.entries(args.cells || {})) {
          const key = String(ref).toUpperCase();
          const norm = normalizeCellPatch(val);
          if (!norm) {
            delete sheet.cells[key];
          } else {
            sheet.cells[key] = { ...(sheet.cells[key] || {}), ...norm };
          }
        }
        await saveWorkbookToDisk(this.files, user, target, wb, isDelimited, sep);
        this.onChanged();
        return { path: toDisplayPath(tokenInfo, target), ...summarizeSheet(wb, idx) };
      }
      case 'sheet_append_rows': {
        const target = resolveScopedPath(tokenInfo, args.path);
        const { wb, isDelimited, sep } = await loadWorkbookFromDisk(this.files, user, target);
        let idx = wb.activeSheet || 0;
        if (args.sheetName) {
          const found = wb.sheets.findIndex((s) => s.name.toLowerCase() === String(args.sheetName).toLowerCase());
          if (found >= 0) idx = found;
        }
        const sheet = wb.sheets[idx];
        if (!sheet.cells) sheet.cells = {};
        let maxR = -1;
        for (const [k, cell] of Object.entries(sheet.cells)) {
          if (cell && cell.v !== undefined && cell.v !== '') {
            const m = /^[A-Z]+(\d+)$/.exec(k);
            if (m) maxR = Math.max(maxR, parseInt(m[1], 10) - 1);
          }
        }
        let nextRow = maxR + 1;
        for (const row of args.rows || []) {
          if (!Array.isArray(row)) continue;
          row.forEach((val, c) => {
            if (val !== null && val !== undefined && val !== '') {
              sheet.cells[`${colToLetter(c)}${nextRow + 1}`] = { v: val };
            }
          });
          nextRow++;
        }
        if (nextRow >= (sheet.rows || 50)) sheet.rows = nextRow + 15;
        await saveWorkbookToDisk(this.files, user, target, wb, isDelimited, sep);
        this.onChanged();
        return { path: toDisplayPath(tokenInfo, target), appendedRows: (args.rows || []).length, ...summarizeSheet(wb, idx) };
      }
      case 'drive_create_share': {
        if (!this.shares) throw new HttpError(500, 'Shares module not enabled.');
        const target = resolveScopedPath(tokenInfo, args.path);
        await this.files.stat(this.files.resolve(user, target));
        const share = this.shares.create(user, {
          path: target,
          expiresInHours: args.expiresInHours ?? 168,
          allowEdit: !!args.allowEdit,
          password: args.password || '',
        });
        return { share };
      }
      default:
        throw new HttpError(400, `Unknown MCP tool "${name}".`);
    }
  }

  async listResources(tokenInfo) {
    // List the files directly inside the token's root folder.
    const rootClient = resolveScopedPath(tokenInfo, '/');
    const entries = await this.files.list(tokenInfo.user, rootClient).catch(() => []);
    return entries
      .filter((e) => e.type === 'file')
      .map((e) => {
        const fullClientPath = (rootClient === '/' ? '' : rootClient) + '/' + e.name;
        const disp = toDisplayPath(tokenInfo, fullClientPath);
        return {
          uri: `rdrive://${disp}`,
          name: e.name,
          mimeType: isSheetName(e.name) ? 'application/json' : 'text/plain',
        };
      });
  }

  async readResource(tokenInfo, uri) {
    const rawPath = String(uri || '').replace(/^rdrive:\/\//, '') || '/';
    const target = resolveScopedPath(tokenInfo, rawPath);
    if (isSheetName(target)) {
      const { wb } = await loadWorkbookFromDisk(this.files, tokenInfo.user, target);
      return [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(summarizeSheet(wb, wb.activeSheet || 0), null, 2),
        },
      ];
    }
    const file = await this.files.fileForDownload(tokenInfo.user, target);
    const text = await fsp.readFile(file.full, 'utf8');
    return [{ uri, mimeType: 'text/plain', text: text.slice(0, MAX_READ_BYTES) }];
  }

  async handleJsonRpc(tokenInfo, message) {
    if (!message || typeof message !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params = {} } = message;
    // Notifications have no id and expect no response object
    if (id === undefined) return null;

    try {
      if (method === 'initialize') {
        const clientProto = params.protocolVersion;
        const protocolVersion = ['2025-03-26', '2024-11-05'].includes(clientProto) ? clientProto : PROTOCOL_VERSION;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
            },
            serverInfo: {
              name: 'rdrive-mcp',
              version: '0.3.0',
            },
          },
        };
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: this.toolsForScope(tokenInfo.scope) },
        };
      }

      if (method === 'tools/call') {
        try {
          const out = await this.executeTool(tokenInfo, params.name, params.arguments || {});
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
              isError: false,
            },
          };
        } catch (toolErr) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Error: ${toolErr.message}` }],
              isError: true,
            },
          };
        }
      }

      if (method === 'resources/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: { resources: await this.listResources(tokenInfo) },
        };
      }

      if (method === 'resources/read') {
        return {
          jsonrpc: '2.0',
          id,
          result: { contents: await this.readResource(tokenInfo, params.uri) },
        };
      }

      if (method === 'prompts/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            prompts: [
              {
                name: 'analyze_spreadsheet',
                description: 'Read and analyze an RDrive Spreadsheet (.rsheet or .csv) and summarize key metrics.',
                arguments: [{ name: 'path', description: 'Path to the spreadsheet', required: true }],
              },
            ],
          },
        };
      }

      if (method === 'prompts/get') {
        const p = params.arguments && params.arguments.path ? params.arguments.path : '/Budget.rsheet';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            description: `Analyze spreadsheet at ${p}`,
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Please call sheet_read on "${p}", inspect its formulas and evaluated values, and provide a clear summary of its key figures.`,
                },
              },
            ],
          },
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message || 'Internal error' },
      };
    }
  }
}

module.exports = { McpServer, resolveScopedPath };
