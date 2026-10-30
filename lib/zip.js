// Streaming ZIP creator (PKZIP 2.0, UTF-8 names, Deflate + Data Descriptors) using only Node built-ins.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { PART_SUFFIX } = require('./files');

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function writeChunk(stream, buf) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      stream.removeListener('drain', onDrain);
      reject(err);
    };
    const onDrain = () => {
      stream.removeListener('error', onErr);
      resolve();
    };
    if (stream.write(buf)) resolve();
    else {
      stream.once('drain', onDrain);
      stream.once('error', onErr);
    }
  });
}

async function collectZipEntries(rootDir, prefix = '') {
  const out = [];
  const dirents = await fsp.readdir(rootDir, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const d of dirents) {
    if (d.name.endsWith(PART_SUFFIX)) continue;
    if (!d.isFile() && !d.isDirectory()) continue;
    const full = path.join(rootDir, d.name);
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) {
      const sub = await collectZipEntries(full, rel);
      if (!sub.length) {
        const st = await fsp.stat(full).catch(() => null);
        if (st) out.push({ full, zipPath: `${rel}/`, isDir: true, mtime: st.mtime });
      } else {
        out.push(...sub);
      }
    } else if (d.isFile()) {
      const st = await fsp.stat(full).catch(() => null);
      if (st) out.push({ full, zipPath: rel, isDir: false, mtime: st.mtime });
    }
  }
  return out;
}

async function streamFolderAsZip(folderFull, rootPrefix, outStream) {
  const entries = await collectZipEntries(folderFull, rootPrefix);
  const centralDir = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.zipPath, 'utf8');
    const { dosTime, dosDate } = dosDateTime(entry.mtime);
    const isDir = entry.isDir;
    // Flag bit 11 (0x0800) = UTF-8 filename; bit 3 (0x0008) = data descriptor follows data for files.
    const flags = isDir ? 0x0800 : 0x0808;
    const method = isDir ? 0 : 8; // 0 = Store (for directory entries), 8 = Deflate

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(0, 14); // CRC-32 (in data descriptor for files)
    localHeader.writeUInt32LE(0, 18); // Compressed size
    localHeader.writeUInt32LE(0, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length
    nameBuf.copy(localHeader, 30);

    const localHeaderOffset = offset;
    await writeChunk(outStream, localHeader);
    offset += localHeader.length;

    let crc = 0;
    let compressedSize = 0;
    let uncompressedSize = 0;

    if (!isDir) {
      await new Promise((resolve, reject) => {
        const deflate = zlib.createDeflateRaw();
        const readStream = fs.createReadStream(entry.full);
        readStream.on('data', (chunk) => {
          crc = zlib.crc32(chunk, crc);
          uncompressedSize += chunk.length;
        });
        readStream.on('error', reject);
        deflate.on('error', reject);
        deflate.on('data', (chunk) => {
          compressedSize += chunk.length;
          offset += chunk.length;
          if (!outStream.write(chunk)) {
            deflate.pause();
            outStream.once('drain', () => deflate.resume());
          }
        });
        deflate.on('end', resolve);
        readStream.pipe(deflate);
      });

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0); // Data descriptor signature
      descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(compressedSize >>> 0, 8);
      descriptor.writeUInt32LE(uncompressedSize >>> 0, 12);
      await writeChunk(outStream, descriptor);
      offset += descriptor.length;
    }

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // Central directory file header signature
    central.writeUInt16LE(20, 4); // Version made by
    central.writeUInt16LE(20, 6); // Version needed to extract
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressedSize >>> 0, 20);
    central.writeUInt32LE(uncompressedSize >>> 0, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // Extra field length
    central.writeUInt16LE(0, 32); // File comment length
    central.writeUInt16LE(0, 34); // Disk number start
    central.writeUInt16LE(0, 36); // Internal file attributes
    central.writeUInt32LE(isDir ? 0x10 : 0, 38); // External file attributes
    central.writeUInt32LE(localHeaderOffset >>> 0, 42);
    nameBuf.copy(central, 46);
    centralDir.push(central);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralDir) {
    await writeChunk(outStream, c);
    centralSize += c.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(centralDir.length, 8);
  eocd.writeUInt16LE(centralDir.length, 10);
  eocd.writeUInt32LE(centralSize >>> 0, 12);
  eocd.writeUInt32LE(centralOffset >>> 0, 16);
  eocd.writeUInt16LE(0, 20); // Comment length
  await writeChunk(outStream, eocd);
  outStream.end();
}

module.exports = { streamFolderAsZip };
