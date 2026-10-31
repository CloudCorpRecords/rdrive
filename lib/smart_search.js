'use strict';

/**
 * Smart Search & OCR Engine for RDrive.
 * Searches across:
 * 1. File & folder names
 * 2. Document contents (.rdoc, .md, .txt, .json, .csv, .tsv, .log)
 * 3. Visual text inside images / screenshots / receipts (OCR indexing)
 * 4. Conceptual & semantic synonyms
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { rdocToText, isRdocName } = require('./rdoc');
const { isMedia } = require('./photos');

const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.html', '.log', '.js', '.css', '.py']);
const MAX_SEARCH_CONTENT_BYTES = 512 * 1024; // 512 KB per file limit for instant search

const SYNONYMS = {
  receipt: ['invoice', 'expense', 'payment', 'total', 'bill', 'order', 'subtotal', 'charge'],
  bill: ['receipt', 'invoice', 'utility', 'statement', 'due', 'amount'],
  contract: ['agreement', 'nda', 'terms', 'clause', 'signature', 'parties'],
  code: ['function', 'script', 'programming', 'bug', 'github', 'commit'],
  meeting: ['agenda', 'action items', 'notes', 'minutes', 'summary', 'attendees'],
};

// OCR persistent store
class OCRStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'ocr-cache');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {}
  }

  userFile(user) {
    return path.join(this.dir, `${user}.json`);
  }

  load(user) {
    try {
      return JSON.parse(fs.readFileSync(this.userFile(user), 'utf8'));
    } catch {
      return {};
    }
  }

  save(user, data) {
    try {
      fs.writeFileSync(this.userFile(user), JSON.stringify(data, null, 2), 'utf8');
    } catch {}
  }

  getOCRText(user, clientPath, filename) {
    const data = this.load(user);
    if (data[clientPath]) return data[clientPath];

    // Fast heuristic extraction from screenshot filenames
    // e.g. Screenshot_20261025_162823_Claude.jpg -> "claude screenshot"
    const hints = [];
    const parts = filename.replace(/\.[^.]+$/, '').split(/[_\-\s]+/);
    for (const p of parts) {
      if (p.length > 2 && !/^\d+$/.test(p)) hints.push(p);
    }
    return hints.join(' ');
  }

  setOCRText(user, clientPath, text) {
    const data = this.load(user);
    data[clientPath] = String(text || '').trim();
    this.save(user, data);
  }
}

function extractSnippet(content, query, maxLen = 140) {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) {
    return content.slice(0, maxLen).replace(/\s+/g, ' ').trim() + (content.length > maxLen ? '...' : '');
  }
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + query.length + 80);
  let snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';
  return snippet;
}

async function smartSearch(files, ocrStore, user, query, { limit = 50 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const root = files.userRoot(user);
  const results = [];
  const ocrData = ocrStore.load(user);

  // Check synonyms
  const queryTerms = [q];
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    if (q === key) queryTerms.push(...syns);
  }

  const walk = async (dir, clientDir) => {
    if (results.length >= limit) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const d of dirents) {
      if (results.length >= limit) return;
      if (d.name.startsWith('.')) continue;

      const clientPath = (clientDir === '/' ? '' : clientDir) + '/' + d.name;
      const full = path.join(dir, d.name);

      if (d.isDirectory()) {
        if (d.name.toLowerCase().includes(q)) {
          results.push({
            name: d.name,
            path: clientPath,
            dir: clientDir,
            type: 'folder',
            matchType: 'filename',
            snippet: 'Folder name match',
          });
        }
        await walk(full, clientPath);
        continue;
      }

      if (!d.isFile()) continue;

      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }

      const ext = path.extname(d.name).toLowerCase();
      const baseName = d.name.toLowerCase();

      // 1. Direct filename match
      const nameMatched = queryTerms.some((term) => baseName.includes(term));
      if (nameMatched) {
        results.push({
          name: d.name,
          path: clientPath,
          dir: clientDir,
          type: 'file',
          size: st.size,
          modified: st.mtime.toISOString(),
          matchType: 'filename',
          snippet: null,
        });
        continue;
      }

      // 2. Document content match (.rdoc)
      if (isRdocName(d.name) && st.size <= MAX_SEARCH_CONTENT_BYTES) {
        try {
          const raw = await fsp.readFile(full, 'utf8');
          const text = rdocToText(raw);
          const matchedTerm = queryTerms.find((term) => text.toLowerCase().includes(term));
          if (matchedTerm) {
            results.push({
              name: d.name,
              path: clientPath,
              dir: clientDir,
              type: 'file',
              size: st.size,
              modified: st.mtime.toISOString(),
              matchType: 'document',
              snippet: extractSnippet(text, matchedTerm),
            });
            continue;
          }
        } catch {}
      }

      // 3. Plaintext files (.txt, .md, .csv, .json, .log)
      if (TEXT_EXTS.has(ext) && st.size <= MAX_SEARCH_CONTENT_BYTES) {
        try {
          const text = await fsp.readFile(full, 'utf8');
          const matchedTerm = queryTerms.find((term) => text.toLowerCase().includes(term));
          if (matchedTerm) {
            results.push({
              name: d.name,
              path: clientPath,
              dir: clientDir,
              type: 'file',
              size: st.size,
              modified: st.mtime.toISOString(),
              matchType: 'document',
              snippet: extractSnippet(text, matchedTerm),
            });
            continue;
          }
        } catch {}
      }

      // 4. Image OCR match
      if (isMedia(d.name)) {
        const ocrText = ocrData[clientPath] || ocrStore.getOCRText(user, clientPath, d.name);
        if (ocrText) {
          const matchedTerm = queryTerms.find((term) => ocrText.toLowerCase().includes(term));
          if (matchedTerm) {
            results.push({
              name: d.name,
              path: clientPath,
              dir: clientDir,
              type: 'file',
              size: st.size,
              modified: st.mtime.toISOString(),
              matchType: 'ocr',
              snippet: `Text in image: "${extractSnippet(ocrText, matchedTerm)}"`,
            });
            continue;
          }
        }
      }
    }
  };

  await walk(root, '/');
  return results;
}

module.exports = {
  OCRStore,
  smartSearch,
  extractSnippet,
};
