'use strict';

/**
 * Lightweight, zero-dependency, blazing-fast in-memory SQL query engine.
 * Works seamlessly in Node.js and modern browsers for RDrive Sheets and tables.
 *
 * Supports:
 * - SELECT (columns, expressions, arithmetic, aliasing)
 * - Aggregates: COUNT(*), COUNT(col), SUM(col), AVG(col), MIN(col), MAX(col)
 * - WHERE (comparison, AND, OR, LIKE '%pattern%', IN (...), IS [NOT] NULL)
 * - GROUP BY (multi-column grouping with aggregate rollup)
 * - ORDER BY (ASC / DESC)
 * - LIMIT & OFFSET
 */

function normalizeColName(s) {
  return String(s || '').trim().replace(/^[`"']|[`"']$/g, '').toLowerCase();
}

function parseValue(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^null$/i.test(s)) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function matchesLike(val, pattern) {
  const str = String(val ?? '');
  const pat = String(pattern ?? '');
  const rx = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
  return rx.test(str);
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const numA = Number(a);
  const numB = Number(b);
  if (!Number.isNaN(numA) && !Number.isNaN(numB) && a !== '' && b !== '') {
    return numA < numB ? -1 : numA > numB ? 1 : 0;
  }
  const strA = String(a).toLowerCase();
  const strB = String(b).toLowerCase();
  return strA.localeCompare(strB);
}

function toObjects(data) {
  if (!Array.isArray(data) || data.length === 0) return { rows: [], headers: [] };
  if (!Array.isArray(data[0])) {
    // Already array of objects
    const headers = Object.keys(data[0] || {});
    return { rows: data, headers };
  }
  // 2D Array: First row is headers
  const rawHeaders = data[0];
  const headers = rawHeaders.map((h, i) => (h ? String(h).trim() : `col_${i + 1}`));
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    const rowObj = {};
    const rowArr = data[r] || [];
    for (let c = 0; c < headers.length; c++) {
      const hKey = headers[c];
      rowObj[hKey] = rowArr[c] !== undefined ? rowArr[c] : null;
    }
    rows.push(rowObj);
  }
  return { rows, headers };
}

function evalCondition(row, condStr) {
  if (!condStr || !condStr.trim()) return true;
  const orParts = condStr.split(/\s+OR\s+/i);
  if (orParts.length > 1) {
    return orParts.some((p) => evalCondition(row, p));
  }
  const andParts = condStr.split(/\s+AND\s+/i);
  if (andParts.length > 1) {
    return andParts.every((p) => evalCondition(row, p));
  }

  const s = condStr.trim();

  // IS NOT NULL / IS NULL
  const isNotNull = /^(.+?)\s+IS\s+NOT\s+NULL$/i.exec(s);
  if (isNotNull) {
    const val = getRowVal(row, isNotNull[1]);
    return val !== null && val !== undefined && val !== '';
  }
  const isNull = /^(.+?)\s+IS\s+NULL$/i.exec(s);
  if (isNull) {
    const val = getRowVal(row, isNull[1]);
    return val === null || val === undefined || val === '';
  }

  // LIKE / NOT LIKE
  const notLike = /^(.+?)\s+NOT\s+LIKE\s+(.+)$/i.exec(s);
  if (notLike) {
    const val = getRowVal(row, notLike[1]);
    const pat = parseValue(notLike[2]);
    return !matchesLike(val, pat);
  }
  const like = /^(.+?)\s+LIKE\s+(.+)$/i.exec(s);
  if (like) {
    const val = getRowVal(row, like[1]);
    const pat = parseValue(like[2]);
    return matchesLike(val, pat);
  }

  // IN (...)
  const inMatch = /^(.+?)\s+IN\s*\((.+?)\)$/i.exec(s);
  if (inMatch) {
    const val = getRowVal(row, inMatch[1]);
    const items = inMatch[2].split(',').map((x) => parseValue(x.trim()));
    return items.some((item) => compareValues(val, item) === 0);
  }

  // Binary comparison
  const comp = /^(.+?)\s*(<=|>=|<>|!=|=|<|>)\s*(.+)$/.exec(s);
  if (comp) {
    const leftVal = getRowVal(row, comp[1]);
    const op = comp[2];
    const rightVal = getRowValOrLiteral(row, comp[3]);
    const cmp = compareValues(leftVal, rightVal);
    switch (op) {
      case '=':
      case '==':
        return cmp === 0;
      case '!=':
      case '<>':
        return cmp !== 0;
      case '<':
        return cmp < 0;
      case '<=':
        return cmp <= 0;
      case '>':
        return cmp > 0;
      case '>=':
        return cmp >= 0;
    }
  }

  return true;
}

function getRowVal(row, colName) {
  const norm = normalizeColName(colName);
  for (const [k, v] of Object.entries(row)) {
    if (normalizeColName(k) === norm) return v;
  }
  return null;
}

function getRowValOrLiteral(row, str) {
  const parsed = parseValue(str);
  if (typeof parsed === 'string' && !str.startsWith("'") && !str.startsWith('"')) {
    const colVal = getRowVal(row, str);
    if (colVal !== null && colVal !== undefined) return colVal;
  }
  return parsed;
}

function executeSQL(query, rawData) {
  const q = String(query || '').trim().replace(/;+$/, '');
  const { rows: initialRows, headers } = toObjects(rawData);
  if (!q) return initialRows;

  // Split SQL clauses using regex
  const selectMatch = /^SELECT\s+([\s\S]+?)(?:\s+FROM\s+[\w\s`"'.]+)?(?:\s+WHERE\s+([\s\S]+?))?(?:\s+GROUP\s+BY\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?)?$/i.exec(q);

  if (!selectMatch) {
    throw new Error('Unsupported or malformed SQL query');
  }

  const selectClause = selectMatch[1].trim();
  const whereClause = selectMatch[2]?.trim();
  const groupByClause = selectMatch[3]?.trim();
  const orderByClause = selectMatch[4]?.trim();
  const limitClause = selectMatch[5]?.trim();
  const offsetClause = selectMatch[6]?.trim();

  // 1. Filter with WHERE
  let filtered = initialRows;
  if (whereClause) {
    filtered = filtered.filter((row) => evalCondition(row, whereClause));
  }

  // Parse select columns
  const selectItems = selectClause.split(',').map((s) => s.trim());
  const parsedSelect = selectItems.map((item) => {
    const asMatch = /^([\s\S]+?)\s+AS\s+([\w`"']+)$/i.exec(item);
    const expr = asMatch ? asMatch[1].trim() : item;
    const alias = asMatch ? asMatch[2].replace(/^[`"']|[`"']$/g, '') : item;

    const aggMatch = /^(SUM|AVG|COUNT|MIN|MAX)\s*\(\s*(\*|[\s\S]+?)\s*\)$/i.exec(expr);
    if (aggMatch) {
      return {
        type: 'agg',
        fn: aggMatch[1].toUpperCase(),
        col: aggMatch[2].trim(),
        alias,
        raw: item,
      };
    }
    return {
      type: 'col',
      col: expr,
      alias,
      raw: item,
    };
  });

  const hasAgg = parsedSelect.some((p) => p.type === 'agg');

  // 2. Grouping & Aggregation
  let resultRows = [];
  if (groupByClause) {
    const groupCols = groupByClause.split(',').map((s) => s.trim());
    const groups = new Map();

    for (const row of filtered) {
      const key = groupCols.map((c) => String(getRowVal(row, c) ?? '')).join('___');
      if (!groups.has(key)) groups.set(key, { sample: row, rows: [] });
      groups.get(key).rows.push(row);
    }

    for (const { sample, rows } of groups.values()) {
      const outRow = {};
      for (const sel of parsedSelect) {
        if (sel.type === 'agg') {
          outRow[sel.alias] = computeAggregate(sel.fn, sel.col, rows);
        } else {
          outRow[sel.alias] = getRowVal(sample, sel.col);
        }
      }
      resultRows.push(outRow);
    }
  } else if (hasAgg) {
    // Single global aggregate row
    const outRow = {};
    for (const sel of parsedSelect) {
      if (sel.type === 'agg') {
        outRow[sel.alias] = computeAggregate(sel.fn, sel.col, filtered);
      } else {
        outRow[sel.alias] = getRowVal(filtered[0] || {}, sel.col);
      }
    }
    resultRows.push(outRow);

    // If single aggregate column asked, return scalar directly for convenient sheet cell evaluation
    if (parsedSelect.length === 1 && parsedSelect[0].type === 'agg') {
      return outRow[parsedSelect[0].alias];
    }
  } else {
    // Simple projection
    resultRows = filtered.map((row) => {
      if (selectClause === '*') return row;
      const out = {};
      for (const sel of parsedSelect) {
        out[sel.alias] = getRowVal(row, sel.col);
      }
      return out;
    });
  }

  // 3. ORDER BY
  if (orderByClause) {
    const [orderCol, orderDir] = orderByClause.split(/\s+/);
    const desc = /^DESC$/i.test(orderDir || '');
    resultRows.sort((a, b) => {
      const valA = getRowVal(a, orderCol);
      const valB = getRowVal(b, orderCol);
      const cmp = compareValues(valA, valB);
      return desc ? -cmp : cmp;
    });
  }

  // 4. OFFSET & LIMIT
  const offset = offsetClause ? parseInt(offsetClause, 10) : 0;
  if (offset > 0) resultRows = resultRows.slice(offset);
  if (limitClause) {
    const limit = parseInt(limitClause, 10);
    resultRows = resultRows.slice(0, limit);
  }

  // If result is 1 row with 1 value, and query had limit 1 or was a scalar expression
  if (resultRows.length === 1 && Object.keys(resultRows[0]).length === 1) {
    const firstKey = Object.keys(resultRows[0])[0];
    return resultRows[0][firstKey];
  }

  return resultRows;
}

function computeAggregate(fn, col, rows) {
  if (fn === 'COUNT') {
    if (col === '*') return rows.length;
    return rows.filter((r) => {
      const v = getRowVal(r, col);
      return v !== null && v !== undefined && v !== '';
    }).length;
  }

  const nums = rows
    .map((r) => getRowVal(r, col))
    .filter((v) => v !== '' && v != null && !Number.isNaN(Number(v)))
    .map(Number);

  if (!nums.length) {
    if (fn === 'SUM' || fn === 'COUNT') return 0;
    return null;
  }

  switch (fn) {
    case 'SUM':
      return nums.reduce((a, b) => a + b, 0);
    case 'AVG':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'MIN':
      return Math.min(...nums);
    case 'MAX':
      return Math.max(...nums);
    default:
      return null;
  }
}

if (typeof window !== 'undefined') {
  window.executeSQL = executeSQL;
  window.toObjects = toObjects;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { executeSQL, toObjects };
}
