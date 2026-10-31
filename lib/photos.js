'use strict';

/**
 * Photos Timeline & Media Gallery Engine for RDrive.
 * Scans phone backups and drive storage, organizes images and videos
 * into clean chronological groups (Today, Yesterday, Month YYYY),
 * and surfaces device sources, dimensions, and playback metadata.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.svg']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

function isMedia(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext);
}

function isVideo(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return VIDEO_EXTS.has(ext);
}

function formatGroupDate(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const itemDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffDays = Math.round((today - itemDay) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
}

function parseCaptureDate(filename, parentPath, mtime) {
  // 1. Try filename date, e.g. 20251007 or 2025-10-07
  const fnMatch = /(?:^|[_-])(20\d{2})[-_]?(\d{2})[-_]?(\d{2})(?:[_-]|\b)/.exec(filename);
  if (fnMatch) {
    const y = parseInt(fnMatch[1], 10);
    const m = parseInt(fnMatch[2], 10) - 1;
    const d = parseInt(fnMatch[3], 10);
    if (y >= 2000 && y <= 2035 && m >= 0 && m <= 11 && d >= 1 && d <= 31) {
      return new Date(y, m, d);
    }
  }

  // 2. Try parent folder, e.g. /2025-10/
  const parentMatch = /\/(20\d{2})-(\d{2})\b/.exec(parentPath);
  if (parentMatch) {
    const y = parseInt(parentMatch[1], 10);
    const m = parseInt(parentMatch[2], 10) - 1;
    if (y >= 2000 && y <= 2035 && m >= 0 && m <= 11) {
      return new Date(y, m, 1);
    }
  }

  return mtime;
}

async function collectMedia(rootDir, clientPrefix = '', results = []) {
  let entries = [];
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue; // skip hidden / temp
    const fullPath = path.join(rootDir, ent.name);
    const clientPath = clientPrefix ? `${clientPrefix}/${ent.name}` : `/${ent.name}`;

    if (ent.isDirectory()) {
      await collectMedia(fullPath, clientPath, results);
    } else if (ent.isFile() && isMedia(ent.name)) {
      try {
        const st = await fsp.stat(fullPath);
        let device = null;
        if (clientPath.startsWith('/Backups/')) {
          const parts = clientPath.split('/');
          if (parts.length > 2) device = parts[2];
        }

        const captureDate = parseCaptureDate(ent.name, clientPath, st.mtime);

        results.push({
          path: clientPath,
          name: ent.name,
          size: st.size,
          mtime: st.mtime.toISOString(),
          timestamp: captureDate.getTime(),
          dateFormatted: captureDate.toISOString().slice(0, 10),
          isVideo: isVideo(ent.name),
          device,
        });
      } catch {}
    }
  }
  return results;
}

async function getPhotosTimeline(files, user, { filter = 'all', limit = 200, offset = 0 } = {}) {
  const userRoot = files.userRoot(user);
  const mediaList = await collectMedia(userRoot);

  // Filter if requested
  let filtered = mediaList;
  if (filter === 'videos') {
    filtered = mediaList.filter((m) => m.isVideo);
  } else if (filter === 'backups') {
    filtered = mediaList.filter((m) => m.device !== null);
  }

  // Sort newest first
  filtered.sort((a, b) => b.timestamp - a.timestamp);

  const total = filtered.length;
  const paged = filtered.slice(offset, offset + limit);

  // Group by relative day / month
  const groupMap = new Map();
  for (const item of paged) {
    const d = new Date(item.timestamp);
    const groupKey = formatGroupDate(d);
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, { title: groupKey, items: [] });
    }
    groupMap.get(groupKey).items.push(item);
  }

  const groups = Array.from(groupMap.values());
  const videosCount = mediaList.filter((m) => m.isVideo).length;
  const photosCount = mediaList.length - videosCount;

  return {
    groups,
    total,
    stats: {
      totalMedia: mediaList.length,
      photosCount,
      videosCount,
    },
  };
}

module.exports = {
  getPhotosTimeline,
  isMedia,
  isVideo,
};
