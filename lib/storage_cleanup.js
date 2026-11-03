// Storage Analytics & Duplicate File Finder for rdrive.
// Scans user storage, computes breakdown by category, isolates duplicates and large files.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const EXT_CATEGORIES = {
  photos: ['jpg', 'jpeg', 'png', 'heic', 'webp', 'avif', 'gif', 'bmp'],
  videos: ['mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'],
  documents: ['rdoc', 'docx', 'odt', 'pdf', 'txt', 'md'],
  sheets: ['rsheet', 'xlsx', 'ods', 'csv', 'tsv'],
  code: ['js', 'py', 'sh', 'json', 'css', 'html', 'sql', 'yml', 'yaml', 'env'],
  archives: ['zip', 'tar', 'gz', '7z', 'rar'],
};

function categoryFor(filePath, isDir) {
  if (isDir) return 'folders';
  if (filePath.includes('/Backups/')) return 'backups';
  const ext = path.extname(filePath).slice(1).toLowerCase();
  for (const [cat, exts] of Object.entries(EXT_CATEGORIES)) {
    if (exts.includes(ext)) return cat;
  }
  return 'other';
}

function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function fastFileSignature(filePath, size) {
  if (size <= 16384) {
    return fileHash(filePath);
  }
  const fd = await fsp.open(filePath, 'r');
  try {
    const buf1 = Buffer.alloc(8192);
    const { bytesRead: r1 } = await fd.read(buf1, 0, 8192, 0);
    const buf2 = Buffer.alloc(8192);
    const { bytesRead: r2 } = await fd.read(buf2, 0, 8192, Math.max(0, size - 8192));
    const h = crypto.createHash('sha256');
    h.update(buf1.subarray(0, r1));
    h.update(buf2.subarray(0, r2));
    h.update(String(size));
    return h.digest('hex');
  } finally {
    await fd.close();
  }
}

async function getStorageAnalytics(filesManager, user) {
  const root = filesManager.userRoot(user);
  if (!fs.existsSync(root)) {
    return {
      totalBytes: 0,
      totalFiles: 0,
      categories: {},
      duplicates: [],
      largeFiles: [],
    };
  }

  const allFiles = [];
  let totalBytes = 0;

  async function walk(dir, relPath = '') {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = relPath ? `${relPath}/${ent.name}` : `/${ent.name}`;

      if (ent.isDirectory()) {
        await walk(full, rel);
      } else if (ent.isFile()) {
        try {
          const stat = await fsp.stat(full);
          totalBytes += stat.size;
          allFiles.push({
            path: rel,
            name: ent.name,
            full,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            category: categoryFor(rel, false),
          });
        } catch {}
      }
    }
  }

  await walk(root);

  // Group by category
  const categories = {
    backups: 0,
    photos: 0,
    videos: 0,
    audio: 0,
    documents: 0,
    sheets: 0,
    code: 0,
    archives: 0,
    other: 0,
  };

  for (const f of allFiles) {
    if (categories[f.category] !== undefined) {
      categories[f.category] += f.size;
    } else {
      categories.other += f.size;
    }
  }

  // Large files (> 10 MB)
  const largeFiles = allFiles
    .filter((f) => f.size >= 10 * 1024 * 1024)
    .sort((a, b) => b.size - a.size)
    .slice(0, 30)
    .map((f) => ({ path: f.path, name: f.name, size: f.size, mtime: f.mtime }));

  // Find duplicates: group by size first
  const sizeMap = new Map();
  for (const f of allFiles) {
    if (f.size > 0) {
      if (!sizeMap.has(f.size)) sizeMap.set(f.size, []);
      sizeMap.get(f.size).push(f);
    }
  }

  const duplicates = [];
  for (const [size, candidateList] of sizeMap) {
    if (candidateList.length > 1) {
      // Hash candidates
      const hashMap = new Map();
      for (const item of candidateList) {
        try {
          const hash = await fastFileSignature(item.full, item.size);
          if (!hashMap.has(hash)) hashMap.set(hash, []);
          hashMap.get(hash).push(item);
        } catch {}
      }

      for (const [sha256, dupList] of hashMap) {
        if (dupList.length > 1) {
          duplicates.push({
            sha256,
            size,
            potentialSavings: size * (dupList.length - 1),
            files: dupList.map((d) => ({ path: d.path, name: d.name, mtime: d.mtime })),
          });
        }
      }
    }
  }

  duplicates.sort((a, b) => b.potentialSavings - a.potentialSavings);

  return {
    totalBytes,
    totalFiles: allFiles.length,
    categories,
    duplicates: duplicates.slice(0, 50),
    largeFiles,
  };
}

module.exports = { getStorageAnalytics, categoryFor };
