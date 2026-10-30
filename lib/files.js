// File operations, confined to each user's own folder under data/files/<user>.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const PART_SUFFIX = '.rdrive-part';
// Characters Windows (and sanity) forbid in file names, plus control characters.
const BAD_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateName(name) {
  if (typeof name !== 'string' || !name || name.length > 255) throw new HttpError(400, 'Invalid name.');
  if (name === '.' || name === '..') throw new HttpError(400, 'Invalid name.');
  if (BAD_NAME_CHARS.test(name)) throw new HttpError(400, 'Name contains characters that are not allowed: < > : " / \\ | ? *');
  if (/[. ]$/.test(name)) throw new HttpError(400, 'Name cannot end with a dot or a space.');
  if (RESERVED_WIN.test(name)) throw new HttpError(400, 'That name is reserved by the operating system.');
  if (name.endsWith(PART_SUFFIX)) throw new HttpError(400, 'Invalid name.');
  return name;
}

// Split a client path like "/photos/2024" into validated segments.
function segments(p) {
  if (p == null) p = '';
  if (typeof p !== 'string') throw new HttpError(400, 'Invalid path.');
  return p.split('/').filter(Boolean).map(validateName);
}

class Files {
  constructor(dataDir) {
    this.filesDir = path.join(dataDir, 'files');
    this.trashDir = path.join(dataDir, 'trash');
    fs.mkdirSync(this.filesDir, { recursive: true });
    fs.mkdirSync(this.trashDir, { recursive: true });
  }

  userRoot(user) {
    const root = path.join(this.filesDir, user);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  // Resolve a client path to an absolute path that is guaranteed to sit inside the user's root.
  resolve(user, p) {
    const root = this.userRoot(user);
    const full = path.join(root, ...segments(p));
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(400, 'Invalid path.');
    return full;
  }

  async stat(full) {
    try {
      return await fsp.stat(full);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, 'Not found.');
      throw err;
    }
  }

  async list(user, p) {
    const dir = this.resolve(user, p);
    const st = await this.stat(dir);
    if (!st.isDirectory()) throw new HttpError(400, 'Not a folder.');
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      if (d.name.endsWith(PART_SUFFIX)) continue;
      if (!d.isFile() && !d.isDirectory()) continue; // skip symlinks and special files
      try {
        const s = await fsp.stat(path.join(dir, d.name));
        entries.push({
          name: d.name,
          type: d.isDirectory() ? 'folder' : 'file',
          size: d.isDirectory() ? null : s.size,
          modified: s.mtime.toISOString(),
        });
      } catch {
        // File vanished between readdir and stat; skip it.
      }
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'folder' ? -1 : 1));
    return entries;
  }

  // Pick "name (1).ext", "name (2).ext", ... if name is already taken in dir.
  async freeName(dir, name) {
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    let candidate = name;
    for (let i = 1; fs.existsSync(path.join(dir, candidate)); i++) {
      candidate = `${base} (${i})${ext}`;
    }
    return candidate;
  }

  // Stream a request body into a file. Writes to a temp file first so a dropped
  // connection never leaves a truncated file behind.
  async upload(user, dirPath, name, body, { overwrite = false } = {}) {
    validateName(name);
    const dir = this.resolve(user, dirPath);
    const st = await this.stat(dir);
    if (!st.isDirectory()) throw new HttpError(400, 'Upload target is not a folder.');
    const tmp = path.join(dir, `.${crypto.randomBytes(6).toString('hex')}${PART_SUFFIX}`);
    try {
      await pipeline(body, fs.createWriteStream(tmp, { flags: 'wx' }));
      let finalName = name;
      const target = path.join(dir, name);
      if (fs.existsSync(target)) {
        const tst = await fsp.stat(target);
        if (!overwrite || tst.isDirectory()) finalName = await this.freeName(dir, name);
      }
      await fsp.rename(tmp, path.join(dir, finalName));
      return finalName;
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  async mkdir(user, dirPath, name) {
    validateName(name);
    const parent = this.resolve(user, dirPath);
    const full = path.join(parent, name);
    if (fs.existsSync(full)) throw new HttpError(409, 'Something with that name already exists.');
    await fsp.mkdir(full);
  }

  // Rename and move are the same operation: from one path to another.
  async move(user, from, to) {
    const src = this.resolve(user, from);
    const dst = this.resolve(user, to);
    if (src === this.userRoot(user)) throw new HttpError(400, 'Cannot move your root folder.');
    const srcStat = await this.stat(src);
    if (fs.existsSync(dst)) {
      // Allow case-only renames on case-insensitive disks (same file, different spelling).
      const dstStat = await fsp.stat(dst);
      if (dstStat.ino !== srcStat.ino || dstStat.dev !== srcStat.dev) {
        throw new HttpError(409, 'Something with that name already exists there.');
      }
    }
    const rel = path.relative(src, dst);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new HttpError(400, 'Cannot move a folder inside itself.');
    }
    const dstParent = await this.stat(path.dirname(dst));
    if (!dstParent.isDirectory()) throw new HttpError(400, 'Destination is not a folder.');
    await fsp.rename(src, dst);
  }

  // Deleting moves to data/trash/<user>/ rather than destroying the file.
  async trash(user, p) {
    const src = this.resolve(user, p);
    if (src === this.userRoot(user)) throw new HttpError(400, 'Cannot delete your root folder.');
    await this.stat(src);
    const userTrash = path.join(this.trashDir, user);
    await fsp.mkdir(userTrash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.rename(src, path.join(userTrash, `${stamp}__${path.basename(src)}`));
  }

  async fileForDownload(user, p) {
    const full = this.resolve(user, p);
    const st = await this.stat(full);
    if (!st.isFile()) throw new HttpError(400, 'Not a file.');
    return { full, size: st.size, mtime: st.mtime, name: path.basename(full) };
  }

  async usage(user) {
    let bytes = 0;
    let files = 0;
    const walk = async (dir) => {
      for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) await walk(full);
        else if (d.isFile()) {
          bytes += (await fsp.stat(full)).size;
          files += 1;
        }
      }
    };
    await walk(this.userRoot(user));
    return { bytes, files };
  }
}

module.exports = { Files, HttpError, validateName };
