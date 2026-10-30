'use strict';

// RDrive Sheets: built-in spreadsheet editor and formula engine for .rsheet, .csv, and .tsv files.
(function () {
  const DEFAULT_ROWS = 50;
  const DEFAULT_COLS = 16;

  // ---------- Column / Cell Helpers ----------

  function colToLetter(col) {
    let s = '';
    let n = col + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function letterToCol(letters) {
    let n = 0;
    const up = letters.toUpperCase();
    for (let i = 0; i < up.length; i++) {
      n = n * 26 + (up.charCodeAt(i) - 64);
    }
    return n - 1;
  }

  function cellKey(r, c) {
    return `${colToLetter(c)}${r + 1}`;
  }

  function parseRef(ref) {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,5})$/.exec(String(ref || '').trim());
    if (!m) return null;
    const c = letterToCol(m[1]);
    const r = parseInt(m[2], 10) - 1;
    if (r < 0 || c < 0) return null;
    return { r, c, key: cellKey(r, c) };
  }

  // ---------- CSV / TSV Parser & Serializer ----------

  function parseDelimited(text, sep = ',') {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === sep) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function serializeDelimited(sheet, sep = ',') {
    let maxR = -1;
    let maxC = -1;
    for (const [k, cell] of Object.entries(sheet.cells || {})) {
      if (cell && cell.v !== undefined && String(cell.v) !== '') {
        const p = parseRef(k);
        if (p) {
          if (p.r > maxR) maxR = p.r;
          if (p.c > maxC) maxC = p.c;
        }
      }
    }
    if (maxR < 0 || maxC < 0) return '';
    const lines = [];
    for (let r = 0; r <= maxR; r++) {
      const fields = [];
      for (let c = 0; c <= maxC; c++) {
        const cell = sheet.cells[cellKey(r, c)];
        const raw = cell && cell.v != null ? String(cell.v) : '';
        if (raw.includes(sep) || raw.includes('"') || raw.includes('\n')) {
          fields.push('"' + raw.replace(/"/g, '""') + '"');
        } else {
          fields.push(raw);
        }
      }
      lines.push(fields.join(sep));
    }
    return lines.join('\n') + '\n';
  }

  function delimitedToWorkbook(text, name, sep = ',') {
    const grid = parseDelimited(text, sep);
    const cells = {};
    let maxC = DEFAULT_COLS;
    for (let r = 0; r < grid.length; r++) {
      if (grid[r].length > maxC) maxC = grid[r].length;
      for (let c = 0; c < grid[r].length; c++) {
        const val = grid[r][c];
        if (val !== '') {
          const num = Number(val);
          const v = val.trim() !== '' && !Number.isNaN(num) && !val.startsWith('0') || val === '0' ? num : val;
          cells[cellKey(r, c)] = { v };
        }
      }
    }
    return {
      format: 'rdrive-sheet',
      version: 1,
      activeSheet: 0,
      sheets: [
        {
          name: name.replace(/\.(csv|tsv|rsheet)$/i, '') || 'Sheet 1',
          rows: Math.max(DEFAULT_ROWS, grid.length + 15),
          cols: Math.max(DEFAULT_COLS, maxC + 4),
          colWidths: {},
          frozenRows: 1,
          cells,
        },
      ],
    };
  }

  // ---------- Formula Evaluator ----------

  function coerceNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v == null || v === '') return 0;
    const n = Number(String(v).replace(/[$,%\s]/g, ''));
    return Number.isNaN(n) ? NaN : n;
  }

  function isNumericVal(v) {
    if (typeof v === 'number') return !Number.isNaN(v);
    if (typeof v === 'string' && v.trim() !== '') {
      return !Number.isNaN(Number(v.trim()));
    }
    return false;
  }

  function tokenizeFormula(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (ch === '"') {
        let str = '';
        i++;
        while (i < expr.length) {
          if (expr[i] === '"' && expr[i + 1] === '"') {
            str += '"';
            i += 2;
          } else if (expr[i] === '"') {
            i++;
            break;
          } else {
            str += expr[i++];
          }
        }
        tokens.push({ type: 'str', value: str });
        continue;
      }
      const two = expr.slice(i, i + 2);
      if (['<=', '>=', '<>', '!=', '=='].includes(two)) {
        tokens.push({ type: 'op', value: two });
        i += 2;
        continue;
      }
      if ('+-*/^&=<>(),:%'.includes(ch)) {
        tokens.push({ type: 'op', value: ch });
        i++;
        continue;
      }
      // Sheet-qualified reference like 'Sheet 2'!A1 or Sheet2!A1:B2
      const rest = expr.slice(i);
      const sheetRefMatch = /^(?:'([^']+)'|([A-Za-z0-9_]+))!(\$?[A-Za-z]{1,3}\$?\d{1,5}(?::\$?[A-Za-z]{1,3}\$?\d{1,5})?)/.exec(rest);
      if (sheetRefMatch) {
        const sheetName = sheetRefMatch[1] || sheetRefMatch[2];
        const refPart = sheetRefMatch[3];
        tokens.push({ type: 'ref', sheet: sheetName, value: refPart.toUpperCase() });
        i += sheetRefMatch[0].length;
        continue;
      }
      const rangeMatch = /^(\$?[A-Za-z]{1,3}\$?\d{1,5}:\$?[A-Za-z]{1,3}\$?\d{1,5})\b/.exec(rest);
      if (rangeMatch) {
        tokens.push({ type: 'range', value: rangeMatch[1].toUpperCase() });
        i += rangeMatch[1].length;
        continue;
      }
      const numMatch = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
      if (numMatch) {
        tokens.push({ type: 'num', value: parseFloat(numMatch[0]) });
        i += numMatch[0].length;
        continue;
      }
      const idMatch = /^\$?[A-Za-z_][A-Za-z0-9_$.]*/.exec(rest);
      if (idMatch) {
        const word = idMatch[0];
        if (expr[i + word.length] === '(') {
          tokens.push({ type: 'fn', value: word.toUpperCase() });
        } else if (/^\$?[A-Za-z]{1,3}\$?\d{1,5}$/.test(word)) {
          tokens.push({ type: 'cell', value: word.replace(/\$/g, '').toUpperCase() });
        } else if (word.toUpperCase() === 'TRUE' || word.toUpperCase() === 'FALSE') {
          tokens.push({ type: 'bool', value: word.toUpperCase() === 'TRUE' });
        } else {
          tokens.push({ type: 'ident', value: word });
        }
        i += word.length;
        continue;
      }
      throw new Error('#ERROR!');
    }
    return tokens;
  }

  function evaluateWorkbook(workbook) {
    const caches = workbook.sheets.map(() => new Map());
    const visiting = new Set();

    function findSheetIndex(name) {
      const low = String(name || '').toLowerCase();
      return workbook.sheets.findIndex((s) => s.name.toLowerCase() === low);
    }

    function expandRange(sheetIdx, rangeStr) {
      const [a, b] = rangeStr.split(':');
      const p1 = parseRef(a);
      const p2 = parseRef(b);
      if (!p1 || !p2) throw new Error('#REF!');
      const r1 = Math.min(p1.r, p2.r);
      const r2 = Math.max(p1.r, p2.r);
      const c1 = Math.min(p1.c, p2.c);
      const c2 = Math.max(p1.c, p2.c);
      const vals = [];
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          vals.push(getCellVal(sheetIdx, cellKey(r, c)));
        }
      }
      return vals;
    }

    function evalCriteria(val, crit) {
      const s = String(crit ?? '');
      const m = /^(<=|>=|<>|!=|=|<|>)(.*)$/.exec(s);
      const op = m ? m[1] : '=';
      const targetRaw = m ? m[2].trim() : s.trim();
      const vNum = Number(val);
      const tNum = Number(targetRaw);
      const bothNum = val !== '' && val != null && targetRaw !== '' && !Number.isNaN(vNum) && !Number.isNaN(tNum);
      const a = bothNum ? vNum : String(val ?? '').toLowerCase();
      const b = bothNum ? tNum : targetRaw.toLowerCase();
      if (op === '=' || op === '==') return a === b;
      if (op === '<>' || op === '!=') return a !== b;
      if (op === '<') return a < b;
      if (op === '<=') return a <= b;
      if (op === '>') return a > b;
      if (op === '>=') return a >= b;
      return false;
    }

    function callFunction(name, args) {
      const flat = () => args.flat(Infinity);
      const nums = () =>
        flat()
          .filter((x) => isNumericVal(x))
          .map(Number);

      switch (name) {
        case 'SUM':
          return nums().reduce((a, b) => a + b, 0);
        case 'AVERAGE':
        case 'AVG': {
          const n = nums();
          if (!n.length) throw new Error('#DIV/0!');
          return n.reduce((a, b) => a + b, 0) / n.length;
        }
        case 'MIN': {
          const n = nums();
          return n.length ? Math.min(...n) : 0;
        }
        case 'MAX': {
          const n = nums();
          return n.length ? Math.max(...n) : 0;
        }
        case 'MEDIAN': {
          const n = nums().sort((a, b) => a - b);
          if (!n.length) return 0;
          const mid = Math.floor(n.length / 2);
          return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
        }
        case 'PRODUCT': {
          const n = nums();
          return n.length ? n.reduce((a, b) => a * b, 1) : 0;
        }
        case 'COUNT':
          return nums().length;
        case 'COUNTA':
          return flat().filter((x) => x !== '' && x != null).length;
        case 'COUNTIF': {
          const range = Array.isArray(args[0]) ? args[0] : [args[0]];
          const crit = args[1];
          return range.filter((v) => evalCriteria(v, crit)).length;
        }
        case 'SUMIF': {
          const range = Array.isArray(args[0]) ? args[0] : [args[0]];
          const crit = args[1];
          const sumRange = args[2] ? (Array.isArray(args[2]) ? args[2] : [args[2]]) : range;
          let total = 0;
          for (let i = 0; i < range.length; i++) {
            if (evalCriteria(range[i], crit) && isNumericVal(sumRange[i])) {
              total += Number(sumRange[i]);
            }
          }
          return total;
        }
        case 'IF':
          return Boolean(args[0]) ? (args[1] ?? '') : (args[2] ?? '');
        case 'IFS': {
          for (let i = 0; i < args.length - 1; i += 2) {
            if (Boolean(args[i])) return args[i + 1];
          }
          throw new Error('#N/A');
        }
        case 'AND':
          return flat().every(Boolean);
        case 'OR':
          return flat().some(Boolean);
        case 'NOT':
          return !Boolean(args[0]);
        case 'TRUE':
          return true;
        case 'FALSE':
          return false;
        case 'ROUND': {
          const v = coerceNumber(args[0]);
          const d = args[1] != null ? coerceNumber(args[1]) : 0;
          const f = Math.pow(10, d);
          return Math.round(v * f) / f;
        }
        case 'ROUNDUP':
        case 'CEIL':
        case 'CEILING': {
          const v = coerceNumber(args[0]);
          const d = args[1] != null ? coerceNumber(args[1]) : 0;
          const f = Math.pow(10, d);
          return Math.ceil(v * f) / f;
        }
        case 'ROUNDDOWN':
        case 'FLOOR':
        case 'INT': {
          const v = coerceNumber(args[0]);
          const d = args[1] != null ? coerceNumber(args[1]) : 0;
          const f = Math.pow(10, d);
          return Math.floor(v * f) / f;
        }
        case 'ABS':
          return Math.abs(coerceNumber(args[0]));
        case 'SQRT': {
          const v = coerceNumber(args[0]);
          if (v < 0) throw new Error('#NUM!');
          return Math.sqrt(v);
        }
        case 'POW':
        case 'POWER':
          return Math.pow(coerceNumber(args[0]), coerceNumber(args[1]));
        case 'MOD': {
          const d = coerceNumber(args[1]);
          if (d === 0) throw new Error('#DIV/0!');
          return coerceNumber(args[0]) % d;
        }
        case 'PI':
          return Math.PI;
        case 'RAND':
          return Math.random();
        case 'CONCAT':
        case 'CONCATENATE':
          return flat().map((x) => (x == null ? '' : String(x))).join('');
        case 'UPPER':
          return String(args[0] ?? '').toUpperCase();
        case 'LOWER':
          return String(args[0] ?? '').toLowerCase();
        case 'TRIM':
          return String(args[0] ?? '').trim().replace(/\s+/g, ' ');
        case 'LEN':
          return String(args[0] ?? '').length;
        case 'LEFT':
          return String(args[0] ?? '').slice(0, args[1] != null ? coerceNumber(args[1]) : 1);
        case 'RIGHT': {
          const s = String(args[0] ?? '');
          const n = args[1] != null ? coerceNumber(args[1]) : 1;
          return n <= 0 ? '' : s.slice(-n);
        }
        case 'MID': {
          const s = String(args[0] ?? '');
          const start = Math.max(1, coerceNumber(args[1])) - 1;
          const len = Math.max(0, coerceNumber(args[2]));
          return s.slice(start, start + len);
        }
        case 'TODAY':
          return new Date().toISOString().slice(0, 10);
        case 'NOW':
          return new Date().toISOString().replace('T', ' ').slice(0, 19);
        default:
          throw new Error('#NAME?');
      }
    }

    function evalFormula(sheetIdx, formulaStr) {
      const tokens = tokenizeFormula(formulaStr);
      let pos = 0;

      function peek() {
        return tokens[pos] || null;
      }
      function consume() {
        return tokens[pos++];
      }

      function parseComparison() {
        let left = parseConcat();
        while (peek() && peek().type === 'op' && ['=', '==', '<>', '!=', '<', '<=', '>', '>='].includes(peek().value)) {
          const op = consume().value;
          const right = parseConcat();
          const lCmp = typeof left === 'string' ? left.toLowerCase() : left;
          const rCmp = typeof right === 'string' ? right.toLowerCase() : right;
          if (op === '=' || op === '==') left = lCmp === rCmp;
          else if (op === '<>' || op === '!=') left = lCmp !== rCmp;
          else if (op === '<') left = lCmp < rCmp;
          else if (op === '<=') left = lCmp <= rCmp;
          else if (op === '>') left = lCmp > rCmp;
          else if (op === '>=') left = lCmp >= rCmp;
        }
        return left;
      }

      function parseConcat() {
        let left = parseAdd();
        while (peek() && peek().type === 'op' && peek().value === '&') {
          consume();
          const right = parseAdd();
          left = String(left ?? '') + String(right ?? '');
        }
        return left;
      }

      function parseAdd() {
        let left = parseMul();
        while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
          const op = consume().value;
          const right = parseMul();
          const a = coerceNumber(left);
          const b = coerceNumber(right);
          if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('#VALUE!');
          left = op === '+' ? a + b : a - b;
        }
        return left;
      }

      function parseMul() {
        let left = parsePow();
        while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
          const op = consume().value;
          const right = parsePow();
          const a = coerceNumber(left);
          const b = coerceNumber(right);
          if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('#VALUE!');
          if (op === '/' && b === 0) throw new Error('#DIV/0!');
          left = op === '*' ? a * b : a / b;
        }
        return left;
      }

      function parsePow() {
        let left = parseUnary();
        while (peek() && peek().type === 'op' && peek().value === '^') {
          consume();
          const right = parseUnary();
          left = Math.pow(coerceNumber(left), coerceNumber(right));
        }
        if (peek() && peek().type === 'op' && peek().value === '%') {
          consume();
          left = coerceNumber(left) / 100;
        }
        return left;
      }

      function parseUnary() {
        if (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
          const op = consume().value;
          const v = coerceNumber(parseUnary());
          return op === '-' ? -v : v;
        }
        return parsePrimary();
      }

      function parsePrimary() {
        const t = consume();
        if (!t) throw new Error('#ERROR!');
        if (t.type === 'num' || t.type === 'str' || t.type === 'bool') return t.value;
        if (t.type === 'cell') {
          const v = getCellVal(sheetIdx, t.value);
          if (typeof v === 'string' && v.startsWith('#')) throw new Error(v);
          return v;
        }
        if (t.type === 'range') {
          return expandRange(sheetIdx, t.value);
        }
        if (t.type === 'ref') {
          const targetIdx = findSheetIndex(t.sheet);
          if (targetIdx < 0) throw new Error('#REF!');
          const clean = t.value.replace(/\$/g, '');
          if (clean.includes(':')) return expandRange(targetIdx, clean);
          const v = getCellVal(targetIdx, clean);
          if (typeof v === 'string' && v.startsWith('#')) throw new Error(v);
          return v;
        }
        if (t.type === 'fn') {
          const open = consume();
          if (!open || open.value !== '(') throw new Error('#ERROR!');
          if (t.value === 'IFERROR') {
            // Special lazy handling for IFERROR(expr, fallback)
            let depth = 0;
            const firstTokens = [];
            while (peek()) {
              const tk = peek();
              if (tk.type === 'op' && tk.value === '(') depth++;
              if (tk.type === 'op' && tk.value === ')') {
                if (depth === 0) break;
                depth--;
              }
              if (tk.type === 'op' && tk.value === ',' && depth === 0) break;
              firstTokens.push(consume());
            }
            let fallbackVal = '';
            if (peek() && peek().value === ',') {
              consume();
              fallbackVal = parseComparison();
            }
            const close = consume();
            if (!close || close.value !== ')') throw new Error('#ERROR!');
            try {
              const savedTokens = tokens.slice();
              const subExpr = firstTokens.map((x) => (x.type === 'str' ? `"${x.value}"` : x.type === 'fn' ? x.value : x.value)).join(' ');
              const res = evalFormula(sheetIdx, subExpr);
              if (typeof res === 'string' && res.startsWith('#')) return fallbackVal;
              return res;
            } catch {
              return fallbackVal;
            }
          }
          const args = [];
          if (!peek() || peek().value !== ')') {
            for (;;) {
              const next = peek();
              if (next && next.type === 'range' && tokens[pos + 1] && (tokens[pos + 1].value === ',' || tokens[pos + 1].value === ')')) {
                consume();
                args.push(expandRange(sheetIdx, next.value));
              } else if (next && next.type === 'ref' && next.value.includes(':') && tokens[pos + 1] && (tokens[pos + 1].value === ',' || tokens[pos + 1].value === ')')) {
                consume();
                const targetIdx = findSheetIndex(next.sheet);
                if (targetIdx < 0) throw new Error('#REF!');
                args.push(expandRange(targetIdx, next.value.replace(/\$/g, '')));
              } else {
                args.push(parseComparison());
              }
              if (peek() && peek().value === ',') {
                consume();
              } else {
                break;
              }
            }
          }
          const close = consume();
          if (!close || close.value !== ')') throw new Error('#ERROR!');
          return callFunction(t.value, args);
        }
        if (t.type === 'op' && t.value === '(') {
          const val = parseComparison();
          const close = consume();
          if (!close || close.value !== ')') throw new Error('#ERROR!');
          return val;
        }
        throw new Error('#NAME?');
      }

      const out = parseComparison();
      if (pos < tokens.length) throw new Error('#ERROR!');
      return out;
    }

    function getCellVal(sheetIdx, key) {
      const sheet = workbook.sheets[sheetIdx];
      if (!sheet) return '';
      const cache = caches[sheetIdx];
      if (cache.has(key)) return cache.get(key);
      const visitId = `${sheetIdx}:${key}`;
      if (visiting.has(visitId)) return '#CYCLE!';
      const cell = sheet.cells && sheet.cells[key];
      if (!cell || cell.v === undefined || cell.v === null || cell.v === '') {
        cache.set(key, '');
        return '';
      }
      const raw = cell.v;
      if (typeof raw === 'string' && raw.startsWith('=')) {
        visiting.add(visitId);
        let result;
        try {
          result = evalFormula(sheetIdx, raw.slice(1));
        } catch (err) {
          result = err.message && err.message.startsWith('#') ? err.message : '#ERROR!';
        }
        visiting.delete(visitId);
        cache.set(key, result);
        return result;
      }
      if (typeof raw === 'string' && isNumericVal(raw)) {
        const num = Number(raw);
        cache.set(key, num);
        return num;
      }
      cache.set(key, raw);
      return raw;
    }

    for (let s = 0; s < workbook.sheets.length; s++) {
      for (const k of Object.keys(workbook.sheets[s].cells || {})) {
        getCellVal(s, k);
      }
    }
    return caches;
  }

  function formatDisplayValue(val, fmt) {
    if (val === '' || val == null) return '';
    if (typeof val === 'string' && val.startsWith('#')) return val;
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    const num = typeof val === 'number' ? val : isNumericVal(val) ? Number(val) : null;
    if (num === null) return String(val);
    switch (fmt) {
      case 'currency':
        return num.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'percent':
        return (num * 100).toFixed(1) + '%';
      case 'integer':
        return Math.round(num).toLocaleString();
      case 'decimal':
        return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      default:
        return Number.isInteger(num) ? String(num) : Number(num.toFixed(6)).toString();
    }
  }

  // ---------- Editor UI Controller ----------

  function openSheetModal({ name, path: filePath, readOnly = false, loadContent, saveContent, onSaved }) {
    const dlg = document.getElementById('sheet-dialog');
    const titleEl = document.getElementById('sheet-title');
    const statusEl = document.getElementById('sheet-save-status');
    const addressEl = document.getElementById('sheet-cell-addr');
    const formulaInput = document.getElementById('sheet-formula-input');
    const gridWrap = document.getElementById('sheet-grid-wrap');
    const tableEl = document.getElementById('sheet-table');
    const tabsEl = document.getElementById('sheet-tabs');
    const statsEl = document.getElementById('sheet-stats');
    const saveBtn = document.getElementById('sheet-save');

    const ext = (name.split('.').pop() || '').toLowerCase();
    const isDelimited = ext === 'csv' || ext === 'tsv';
    const sep = ext === 'tsv' ? '\t' : ',';

    let workbook = null;
    let evalCaches = [];
    let activeR = 0;
    let activeC = 0;
    let selR1 = 0, selC1 = 0, selR2 = 0, selC2 = 0;
    let isDraggingSelection = false;
    let dirty = false;
    let saving = false;
    let autoSaveTimer = null;
    const undoStack = [];
    const redoStack = [];

    titleEl.textContent = name;
    saveBtn.hidden = readOnly;
    formulaInput.readOnly = readOnly;
    document.getElementById('sheet-toolbar-edit').hidden = readOnly;
    document.getElementById('sheet-add-tab').hidden = readOnly || isDelimited;

    function curSheet() {
      return workbook.sheets[workbook.activeSheet || 0];
    }

    function snapshot() {
      undoStack.push(JSON.stringify(workbook));
      if (undoStack.length > 50) undoStack.shift();
      redoStack.length = 0;
    }

    function markDirty() {
      if (readOnly) return;
      dirty = true;
      statusEl.textContent = 'Unsaved changes';
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => performSave(true), 2500);
    }

    async function performSave(silent = false) {
      if (readOnly || saving || !workbook) return;
      clearTimeout(autoSaveTimer);
      saving = true;
      statusEl.textContent = 'Saving…';
      try {
        const payload = isDelimited
          ? serializeDelimited(curSheet(), sep)
          : JSON.stringify(workbook, null, 2);
        await saveContent(payload);
        dirty = false;
        statusEl.textContent = 'All changes saved';
        if (onSaved) onSaved();
      } catch (err) {
        statusEl.textContent = 'Save failed';
        if (!silent && window.rdriveToast) window.rdriveToast(err.message || 'Could not save spreadsheet.');
      } finally {
        saving = false;
      }
    }

    function normRange() {
      return {
        r1: Math.min(selR1, selR2),
        r2: Math.max(selR1, selR2),
        c1: Math.min(selC1, selC2),
        c2: Math.max(selC1, selC2),
      };
    }

    function recompute() {
      evalCaches = evaluateWorkbook(workbook);
    }

    function renderTabs() {
      tabsEl.replaceChildren();
      workbook.sheets.forEach((s, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sheet-tab' + (idx === (workbook.activeSheet || 0) ? ' active' : '');
        btn.textContent = s.name;
        btn.addEventListener('click', () => {
          if (workbook.activeSheet === idx) return;
          commitFormulaBar();
          workbook.activeSheet = idx;
          activeR = 0;
          activeC = 0;
          selR1 = selR2 = 0;
          selC1 = selC2 = 0;
          renderAll();
        });
        if (!readOnly && !isDelimited) {
          btn.addEventListener('dblclick', () => {
            const next = prompt('Rename sheet:', s.name);
            if (next && next.trim() && next.trim() !== s.name) {
              snapshot();
              s.name = next.trim();
              markDirty();
              renderAll();
            }
          });
        }
        tabsEl.appendChild(btn);
      });
    }

    function renderGrid() {
      const sheet = curSheet();
      const rows = sheet.rows || DEFAULT_ROWS;
      const cols = sheet.cols || DEFAULT_COLS;
      const cache = evalCaches[workbook.activeSheet || 0] || new Map();

      tableEl.replaceChildren();
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      const corner = document.createElement('th');
      corner.className = 'sheet-corner';
      corner.textContent = '';
      corner.addEventListener('click', () => {
        selR1 = 0;
        selC1 = 0;
        selR2 = rows - 1;
        selC2 = cols - 1;
        updateSelectionHighlight();
      });
      headRow.appendChild(corner);

      for (let c = 0; c < cols; c++) {
        const th = document.createElement('th');
        th.textContent = colToLetter(c);
        th.dataset.col = c;
        if (sheet.colWidths && sheet.colWidths[c]) {
          th.style.width = `${sheet.colWidths[c]}px`;
          th.style.minWidth = `${sheet.colWidths[c]}px`;
        }
        th.addEventListener('click', (e) => {
          commitFormulaBar();
          activeR = 0;
          activeC = c;
          selR1 = 0;
          selR2 = rows - 1;
          selC1 = e.shiftKey ? selC1 : c;
          selC2 = c;
          syncFormulaBar();
          updateSelectionHighlight();
        });
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      tableEl.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (let r = 0; r < rows; r++) {
        const tr = document.createElement('tr');
        const rth = document.createElement('th');
        rth.className = 'sheet-row-hdr';
        rth.textContent = String(r + 1);
        rth.dataset.row = r;
        rth.addEventListener('click', (e) => {
          commitFormulaBar();
          activeR = r;
          activeC = 0;
          selC1 = 0;
          selC2 = cols - 1;
          selR1 = e.shiftKey ? selR1 : r;
          selR2 = r;
          syncFormulaBar();
          updateSelectionHighlight();
        });
        tr.appendChild(rth);

        for (let c = 0; c < cols; c++) {
          const td = document.createElement('td');
          const key = cellKey(r, c);
          td.dataset.r = r;
          td.dataset.c = c;
          td.dataset.key = key;
          applyCellDom(td, sheet.cells[key], cache.get(key));
          tbody.appendChild(tr);
          tr.appendChild(td);
        }
      }
      tableEl.appendChild(tbody);
      updateSelectionHighlight();
      syncFormulaBar();
    }

    function applyCellDom(td, cell, evaluated) {
      const val = evaluated !== undefined ? evaluated : cell && cell.v !== undefined ? cell.v : '';
      const display = formatDisplayValue(val, cell && cell.fmt);
      td.textContent = display;
      td.className = '';
      if (typeof val === 'string' && val.startsWith('#')) {
        td.classList.add('cell-error');
      } else if (typeof val === 'number' || (cell && cell.fmt && ['currency', 'percent', 'integer', 'decimal'].includes(cell.fmt))) {
        td.classList.add('cell-num');
      }
      td.style.fontWeight = cell && cell.b ? '700' : '';
      td.style.fontStyle = cell && cell.i ? 'italic' : '';
      td.style.textDecoration = cell && cell.u ? 'underline' : '';
      td.style.textAlign = cell && cell.align ? cell.align : '';
      td.style.backgroundColor = cell && cell.bg ? cell.bg : '';
      td.style.color = cell && cell.fg ? cell.fg : '';
    }

    function refreshAllCellValues() {
      recompute();
      const sheet = curSheet();
      const cache = evalCaches[workbook.activeSheet || 0] || new Map();
      for (const td of tableEl.querySelectorAll('td[data-key]')) {
        const key = td.dataset.key;
        applyCellDom(td, sheet.cells[key], cache.get(key));
      }
      updateSelectionHighlight();
    }

    function updateSelectionHighlight() {
      const { r1, r2, c1, c2 } = normRange();
      for (const td of tableEl.querySelectorAll('td[data-key]')) {
        const r = Number(td.dataset.r);
        const c = Number(td.dataset.c);
        td.classList.toggle('active-cell', r === activeR && c === activeC);
        td.classList.toggle('in-range', r >= r1 && r <= r2 && c >= c1 && c <= c2);
      }
      for (const th of tableEl.querySelectorAll('thead th[data-col]')) {
        const c = Number(th.dataset.col);
        th.classList.toggle('hdr-selected', c >= c1 && c <= c2);
      }
      for (const th of tableEl.querySelectorAll('tbody th[data-row]')) {
        const r = Number(th.dataset.row);
        th.classList.toggle('hdr-selected', r >= r1 && r <= r2);
      }
      const single = r1 === r2 && c1 === c2;
      addressEl.textContent = single ? cellKey(activeR, activeC) : `${cellKey(r1, c1)}:${cellKey(r2, c2)}`;
      updateQuickStats(r1, r2, c1, c2);
      syncToolbarState();
    }

    function updateQuickStats(r1, r2, c1, c2) {
      const cache = evalCaches[workbook.activeSheet || 0] || new Map();
      const nums = [];
      let nonEmpty = 0;
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const v = cache.get(cellKey(r, c));
          if (v !== '' && v != null) {
            nonEmpty++;
            if (typeof v === 'number' && !Number.isNaN(v)) nums.push(v);
          }
        }
      }
      if (nums.length >= 2) {
        const sum = nums.reduce((a, b) => a + b, 0);
        const avg = sum / nums.length;
        const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString() : Number(n.toFixed(2)).toLocaleString());
        statsEl.textContent = `Count: ${nonEmpty}  ·  Sum: ${fmt(sum)}  ·  Avg: ${fmt(avg)}  ·  Min: ${fmt(Math.min(...nums))}  ·  Max: ${fmt(Math.max(...nums))}`;
      } else if (nonEmpty > 1) {
        statsEl.textContent = `Count: ${nonEmpty}`;
      } else {
        statsEl.textContent = readOnly ? 'Read-only view' : 'Ready';
      }
    }

    function syncFormulaBar() {
      const sheet = curSheet();
      const cell = sheet.cells[cellKey(activeR, activeC)];
      formulaInput.value = cell && cell.v != null ? String(cell.v) : '';
    }

    function syncToolbarState() {
      const sheet = curSheet();
      const cell = sheet.cells[cellKey(activeR, activeC)] || {};
      document.getElementById('sheet-bold').classList.toggle('active', !!cell.b);
      document.getElementById('sheet-italic').classList.toggle('active', !!cell.i);
      document.getElementById('sheet-underline').classList.toggle('active', !!cell.u);
      document.getElementById('sheet-format').value = cell.fmt || '';
    }

    function setCellRawValue(r, c, rawStr) {
      const sheet = curSheet();
      const key = cellKey(r, c);
      const trimmed = String(rawStr ?? '');
      if (trimmed === '') {
        if (sheet.cells[key]) {
          delete sheet.cells[key].v;
          if (Object.keys(sheet.cells[key]).length === 0) delete sheet.cells[key];
        }
        return;
      }
      let parsed = trimmed;
      if (!trimmed.startsWith('=') && isNumericVal(trimmed) && (!trimmed.startsWith('0') || trimmed === '0' || trimmed.startsWith('0.'))) {
        parsed = Number(trimmed);
      }
      if (!sheet.cells[key]) sheet.cells[key] = {};
      sheet.cells[key].v = parsed;
    }

    function commitFormulaBar() {
      if (readOnly || !workbook) return;
      const sheet = curSheet();
      const key = cellKey(activeR, activeC);
      const existing = sheet.cells[key] && sheet.cells[key].v != null ? String(sheet.cells[key].v) : '';
      if (formulaInput.value !== existing) {
        snapshot();
        setCellRawValue(activeR, activeC, formulaInput.value);
        markDirty();
        refreshAllCellValues();
      }
    }

    function mutateSelectedCells(mutator) {
      if (readOnly) return;
      snapshot();
      const sheet = curSheet();
      const { r1, r2, c1, c2 } = normRange();
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const key = cellKey(r, c);
          if (!sheet.cells[key]) sheet.cells[key] = {};
          mutator(sheet.cells[key], r, c);
          if (Object.keys(sheet.cells[key]).length === 0) delete sheet.cells[key];
        }
      }
      markDirty();
      refreshAllCellValues();
      syncFormulaBar();
    }

    function selectCell(r, c, extend = false) {
      const sheet = curSheet();
      const maxR = (sheet.rows || DEFAULT_ROWS) - 1;
      const maxC = (sheet.cols || DEFAULT_COLS) - 1;
      const nr = Math.max(0, Math.min(maxR, r));
      const nc = Math.max(0, Math.min(maxC, c));
      if (!extend) {
        activeR = nr;
        activeC = nc;
        selR1 = selR2 = nr;
        selC1 = selC2 = nc;
        syncFormulaBar();
      } else {
        selR2 = nr;
        selC2 = nc;
      }
      updateSelectionHighlight();
      const td = tableEl.querySelector(`td[data-r="${nr}"][data-c="${nc}"]`);
      if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function renderAll() {
      recompute();
      renderTabs();
      renderGrid();
    }

    // ---------- Grid Mouse / Touch / Keyboard Events ----------

    const onMouseDown = (e) => {
      const td = e.target.closest('td[data-key]');
      if (!td) return;
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);

      // If user is typing a formula starting with '=' in the formula bar, clicking a cell inserts its reference!
      if (!readOnly && document.activeElement === formulaInput && formulaInput.value.startsWith('=')) {
        const lastCh = formulaInput.value.slice(-1);
        if ('=(+-*/^&,<>:'.includes(lastCh)) {
          e.preventDefault();
          formulaInput.value += cellKey(r, c);
          return;
        }
      }

      commitFormulaBar();
      if (e.shiftKey) {
        selectCell(r, c, true);
      } else {
        // On touch devices, tapping an already-active cell focuses the formula input so the keyboard opens.
        const wasActive = r === activeR && c === activeC && selR1 === selR2 && selC1 === selC2;
        selectCell(r, c, false);
        isDraggingSelection = true;
        if (wasActive && !readOnly && 'ontouchstart' in window) {
          setTimeout(() => formulaInput.focus(), 20);
        }
      }
    };

    const onMouseOver = (e) => {
      if (!isDraggingSelection) return;
      const td = e.target.closest('td[data-key]');
      if (!td) return;
      selectCell(Number(td.dataset.r), Number(td.dataset.c), true);
    };

    const onMouseUp = () => {
      isDraggingSelection = false;
    };

    const onDblClick = (e) => {
      const td = e.target.closest('td[data-key]');
      if (!td || readOnly) return;
      formulaInput.focus();
      formulaInput.setSelectionRange(formulaInput.value.length, formulaInput.value.length);
    };

    const onKeyDown = (e) => {
      if (!dlg.open) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        commitFormulaBar();
        performSave(false);
        return;
      }
      if (document.activeElement === formulaInput) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitFormulaBar();
          formulaInput.blur();
          selectCell(activeR + (e.shiftKey ? -1 : 1), activeC, false);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commitFormulaBar();
          formulaInput.blur();
          selectCell(activeR, activeC + (e.shiftKey ? -1 : 1), false);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          syncFormulaBar();
          formulaInput.blur();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        doRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const prop = e.key.toLowerCase();
        const cur = (curSheet().cells[cellKey(activeR, activeC)] || {})[prop];
        mutateSelectedCells((cell) => {
          if (cur) delete cell[prop];
          else cell[prop] = 1;
        });
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectCell((e.shiftKey ? selR2 : activeR) + 1, e.shiftKey ? selC2 : activeC, e.shiftKey);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectCell((e.shiftKey ? selR2 : activeR) - 1, e.shiftKey ? selC2 : activeC, e.shiftKey);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        selectCell(e.shiftKey ? selR2 : activeR, (e.shiftKey ? selC2 : activeC) + 1, e.shiftKey);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        selectCell(e.shiftKey ? selR2 : activeR, (e.shiftKey ? selC2 : activeC) - 1, e.shiftKey);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        selectCell(activeR, activeC + (e.shiftKey ? -1 : 1), false);
      } else if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        if (!readOnly) {
          formulaInput.focus();
          formulaInput.setSelectionRange(formulaInput.value.length, formulaInput.value.length);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (readOnly) return;
        e.preventDefault();
        mutateSelectedCells((cell) => {
          delete cell.v;
        });
      } else if (!readOnly && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        formulaInput.value = e.key;
        formulaInput.focus();
        formulaInput.setSelectionRange(1, 1);
        e.preventDefault();
      }
    };

    const onCopy = (e) => {
      if (!dlg.open || document.activeElement === formulaInput) return;
      const { r1, r2, c1, c2 } = normRange();
      const cache = evalCaches[workbook.activeSheet || 0] || new Map();
      const lines = [];
      for (let r = r1; r <= r2; r++) {
        const row = [];
        for (let c = c1; c <= c2; c++) {
          const v = cache.get(cellKey(r, c));
          row.push(v == null ? '' : String(v));
        }
        lines.push(row.join('\t'));
      }
      e.clipboardData.setData('text/plain', lines.join('\n'));
      e.preventDefault();
      if (e.type === 'cut' && !readOnly) {
        mutateSelectedCells((cell) => delete cell.v);
      }
    };

    const onPaste = (e) => {
      if (!dlg.open || readOnly || document.activeElement === formulaInput) return;
      const text = e.clipboardData.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      snapshot();
      const rows = text.replace(/\r\n/g, '\n').split('\n');
      const sheet = curSheet();
      for (let dr = 0; dr < rows.length; dr++) {
        const cols = rows[dr].split('\t');
        for (let dc = 0; dc < cols.length; dc++) {
          const tr = activeR + dr;
          const tc = activeC + dc;
          if (tr >= sheet.rows) sheet.rows = tr + 10;
          if (tc >= sheet.cols) sheet.cols = tc + 5;
          setCellRawValue(tr, tc, cols[dc]);
        }
      }
      markDirty();
      renderAll();
    };

    function doUndo() {
      if (!undoStack.length || readOnly) return;
      redoStack.push(JSON.stringify(workbook));
      workbook = JSON.parse(undoStack.pop());
      markDirty();
      renderAll();
    }

    function doRedo() {
      if (!redoStack.length || readOnly) return;
      undoStack.push(JSON.stringify(workbook));
      workbook = JSON.parse(redoStack.pop());
      markDirty();
      renderAll();
    }

    function sortByActiveColumn(ascending) {
      if (readOnly) return;
      snapshot();
      const sheet = curSheet();
      const startRow = sheet.frozenRows ? 1 : 0;
      const rowData = [];
      let maxR = 0;
      for (const k of Object.keys(sheet.cells)) {
        const p = parseRef(k);
        if (p && p.r > maxR) maxR = p.r;
      }
      if (maxR < startRow) return;
      for (let r = startRow; r <= maxR; r++) {
        const rowCells = {};
        let hasAny = false;
        for (let c = 0; c < sheet.cols; c++) {
          const cell = sheet.cells[cellKey(r, c)];
          if (cell) {
            rowCells[c] = { ...cell };
            hasAny = true;
          }
        }
        if (hasAny) rowData.push(rowCells);
      }
      rowData.sort((a, b) => {
        const va = a[activeC] && a[activeC].v != null ? a[activeC].v : '';
        const vb = b[activeC] && b[activeC].v != null ? b[activeC].v : '';
        const cmp = typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, { numeric: true });
        return ascending ? cmp : -cmp;
      });
      for (let r = startRow; r <= maxR; r++) {
        for (let c = 0; c < sheet.cols; c++) delete sheet.cells[cellKey(r, c)];
      }
      rowData.forEach((rowCells, idx) => {
        const r = startRow + idx;
        for (const [c, cell] of Object.entries(rowCells)) {
          sheet.cells[cellKey(r, Number(c))] = cell;
        }
      });
      markDirty();
      refreshAllCellValues();
    }

    // ---------- Toolbar Bindings ----------

    const bindClick = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };

    bindClick('sheet-undo', doUndo);
    bindClick('sheet-redo', doRedo);
    bindClick('sheet-bold', () => {
      const cur = (curSheet().cells[cellKey(activeR, activeC)] || {}).b;
      mutateSelectedCells((c) => (cur ? delete c.b : (c.b = 1)));
    });
    bindClick('sheet-italic', () => {
      const cur = (curSheet().cells[cellKey(activeR, activeC)] || {}).i;
      mutateSelectedCells((c) => (cur ? delete c.i : (c.i = 1)));
    });
    bindClick('sheet-underline', () => {
      const cur = (curSheet().cells[cellKey(activeR, activeC)] || {}).u;
      mutateSelectedCells((c) => (cur ? delete c.u : (c.u = 1)));
    });
    bindClick('sheet-align-left', () => mutateSelectedCells((c) => (c.align = 'left')));
    bindClick('sheet-align-center', () => mutateSelectedCells((c) => (c.align = 'center')));
    bindClick('sheet-align-right', () => mutateSelectedCells((c) => (c.align = 'right')));
    bindClick('sheet-sort-asc', () => sortByActiveColumn(true));
    bindClick('sheet-sort-desc', () => sortByActiveColumn(false));
    bindClick('sheet-add-row', () => {
      if (readOnly) return;
      snapshot();
      curSheet().rows = (curSheet().rows || DEFAULT_ROWS) + 10;
      markDirty();
      renderGrid();
    });
    bindClick('sheet-add-col', () => {
      if (readOnly) return;
      snapshot();
      curSheet().cols = (curSheet().cols || DEFAULT_COLS) + 4;
      markDirty();
      renderGrid();
    });
    bindClick('sheet-clear-fmt', () => {
      mutateSelectedCells((c) => {
        delete c.b;
        delete c.i;
        delete c.u;
        delete c.align;
        delete c.fmt;
        delete c.bg;
        delete c.fg;
      });
    });

    const fmtSelect = document.getElementById('sheet-format');
    if (fmtSelect) {
      fmtSelect.onchange = () => {
        const val = fmtSelect.value;
        mutateSelectedCells((c) => {
          if (!val) delete c.fmt;
          else c.fmt = val;
        });
      };
    }

    const bgSelect = document.getElementById('sheet-bg-color');
    if (bgSelect) {
      bgSelect.onchange = () => {
        const val = bgSelect.value;
        mutateSelectedCells((c) => {
          if (!val) delete c.bg;
          else c.bg = val;
        });
        bgSelect.value = '';
      };
    }

    bindClick('sheet-add-tab', () => {
      if (readOnly || isDelimited) return;
      snapshot();
      const idx = workbook.sheets.length + 1;
      workbook.sheets.push({
        name: `Sheet ${idx}`,
        rows: DEFAULT_ROWS,
        cols: DEFAULT_COLS,
        colWidths: {},
        frozenRows: 1,
        cells: {},
      });
      workbook.activeSheet = workbook.sheets.length - 1;
      markDirty();
      renderAll();
    });

    bindClick('sheet-export-csv', () => {
      if (!workbook) return;
      const csv = serializeDelimited(curSheet(), ',');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name.replace(/\.(rsheet|csv|tsv)$/i, '') + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });

    bindClick('sheet-save', () => {
      commitFormulaBar();
      performSave(false);
    });

    formulaInput.onblur = () => commitFormulaBar();

    tableEl.addEventListener('mousedown', onMouseDown);
    tableEl.addEventListener('mouseover', onMouseOver);
    tableEl.addEventListener('dblclick', onDblClick);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCopy);
    window.addEventListener('paste', onPaste);

    const cleanup = () => {
      clearTimeout(autoSaveTimer);
      tableEl.removeEventListener('mousedown', onMouseDown);
      tableEl.removeEventListener('mouseover', onMouseOver);
      tableEl.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCopy);
      window.removeEventListener('paste', onPaste);
    };

    bindClick('sheet-close', async () => {
      commitFormulaBar();
      if (dirty && !readOnly) await performSave(true);
      dlg.close();
    });
    dlg.addEventListener('close', cleanup, { once: true });

    // ---------- Load Workbook ----------
    statusEl.textContent = 'Loading…';
    if (!dlg.open) dlg.showModal();
    loadContent()
      .then((rawText) => {
        if (isDelimited) {
          workbook = delimitedToWorkbook(rawText, name, sep);
        } else {
          try {
            const parsed = rawText.trim() ? JSON.parse(rawText) : null;
            if (parsed && Array.isArray(parsed.sheets) && parsed.sheets.length) {
              workbook = parsed;
            } else {
              workbook = delimitedToWorkbook(rawText, name, ',');
            }
          } catch {
            workbook = delimitedToWorkbook(rawText, name, ',');
          }
        }
        statusEl.textContent = readOnly ? 'View only' : 'Saved';
        renderAll();
        gridWrap.scrollTop = 0;
        gridWrap.scrollLeft = 0;
      })
      .catch((err) => {
        statusEl.textContent = 'Failed to load';
        if (window.rdriveToast) window.rdriveToast(err.message || 'Could not load spreadsheet.');
      });
  }

  const api = {
    openSheetModal,
    evaluateWorkbook,
    parseDelimited,
    serializeDelimited,
    delimitedToWorkbook,
    colToLetter,
    letterToCol,
  };
  if (typeof window !== 'undefined') window.RDriveSheets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
