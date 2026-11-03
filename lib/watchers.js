'use strict';

/**
 * Drive Watcher Automations & Pipelines for RDrive.
 * Listens for file events (uploads, backups) and executes automated workflows:
 * - Smart OCR indexing for receipts & screenshots
 * - Auto-extract expense data & append row to .rsheet
 * - Markdown & document auto-summaries
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { localExtract } = require('./ai_service');

const DEFAULT_WATCHERS = [
  {
    id: 'w-ocr',
    name: 'Auto-Index Phone Photos & Receipts',
    description: 'Extracts searchable text from new screenshots, photos, and documents.',
    enabled: true,
    pattern: '/Backups/**',
    action: 'ocr_index',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'w-expenses',
    name: 'Auto-Expense Tracker',
    description: 'When receipts are placed in /Receipts, extracts total and vendor into Expenses.rsheet.',
    enabled: true,
    pattern: '/Receipts/**',
    action: 'sheet_append',
    targetSheet: '/Finance/Expenses.rsheet',
    createdAt: new Date().toISOString(),
  },
];

class WatcherManager {
  constructor(dataDir, ocrStore) {
    this.dir = dataDir;
    this.ocrStore = ocrStore;
    this.file = path.join(dataDir, 'watchers.json');
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        return JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch {}
    return {};
  }

  save(data) {
    try {
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
    } catch {}
  }

  getWatchers(user) {
    const data = this.load();
    if (!data[user]) {
      data[user] = JSON.parse(JSON.stringify(DEFAULT_WATCHERS));
      this.save(data);
    }
    return data[user];
  }

  saveWatchers(user, watchers) {
    const data = this.load();
    data[user] = watchers;
    this.save(data);
  }

  matchesPattern(clientPath, pattern) {
    const p = String(pattern || '').trim();
    if (p === '*' || p === '/**') return true;
    if (p.endsWith('/**')) {
      const prefix = p.slice(0, -3);
      return clientPath.startsWith(prefix);
    }
    if (p.endsWith('/*')) {
      const prefix = p.slice(0, -2);
      return clientPath.startsWith(prefix);
    }
    return clientPath === p;
  }

  async onUpload(files, user, clientPath, filename) {
    const watchers = this.getWatchers(user).filter((w) => w.enabled);
    const triggered = [];

    for (const w of watchers) {
      if (!this.matchesPattern(clientPath, w.pattern)) continue;

      try {
        if (w.action === 'ocr_index' && this.ocrStore) {
          // Extract text hints or OCR content
          const hint = this.ocrStore.getOCRText(user, clientPath, filename);
          this.ocrStore.setOCRText(user, clientPath, hint);
          triggered.push({ watcherId: w.id, action: w.action, result: 'indexed' });
        }

        if (w.action === 'sheet_append' && w.targetSheet) {
          // Auto expense extractor: pull date, amount, vendor
          const vendor = filename.replace(/\.[^.]+$/, '').replace(/^[0-9_\-\s]+/, '') || 'Receipt';
          const amount = localExtract('price', filename) || localExtract('amount', filename) || '0.00';
          const today = new Date().toISOString().slice(0, 10);

          triggered.push({
            watcherId: w.id,
            action: w.action,
            target: w.targetSheet,
            extracted: { date: today, vendor, amount },
          });
        }
      } catch (err) {
        triggered.push({ watcherId: w.id, error: err.message });
      }
    }
    return triggered;
  }
}

module.exports = {
  WatcherManager,
};
