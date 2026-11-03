// Manages user-starred files and folders in rdrive.
// Stores starred file paths per user in data/starred/<user>.json.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

class StarredManager {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'starred');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
  }

  userFile(user) {
    const safeUser = user.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.dir, `${safeUser}.json`);
  }

  load(user) {
    if (this.cache.has(user)) return this.cache.get(user);
    const file = this.userFile(user);
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const set = new Set(Array.isArray(data) ? data : []);
        this.cache.set(user, set);
        return set;
      }
    } catch {}
    const set = new Set();
    this.cache.set(user, set);
    return set;
  }

  async save(user) {
    const set = this.load(user);
    const file = this.userFile(user);
    await fsp.writeFile(file, JSON.stringify(Array.from(set), null, 2), 'utf8');
  }

  list(user) {
    return Array.from(this.load(user));
  }

  isStarred(user, filePath) {
    return this.load(user).has(filePath);
  }

  async toggle(user, filePath) {
    const set = this.load(user);
    let starred = false;
    if (set.has(filePath)) {
      set.delete(filePath);
      starred = false;
    } else {
      set.add(filePath);
      starred = true;
    }
    await this.save(user);
    return { path: filePath, starred };
  }

  async remove(user, filePath) {
    const set = this.load(user);
    if (set.delete(filePath)) {
      await this.save(user);
    }
  }

  async rename(user, oldPath, newPath) {
    const set = this.load(user);
    let changed = false;
    for (const p of Array.from(set)) {
      if (p === oldPath) {
        set.delete(p);
        set.add(newPath);
        changed = true;
      } else if (p.startsWith(oldPath + '/')) {
        set.delete(p);
        set.add(newPath + p.slice(oldPath.length));
        changed = true;
      }
    }
    if (changed) await this.save(user);
  }
}

module.exports = { StarredManager };
