const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Files } = require('../lib/files');
const { getStorageAnalytics } = require('../lib/storage_cleanup');

test('storage cleanup: computes category breakdowns, duplicate clusters, and large files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-storage-test-'));
  try {
    const files = new Files(tmp);
    const user = 'alice';

    // Create sample directories and files
    await files.mkdir(user, '/', 'Backups');
    await files.mkdir(user, '/Backups', 'Phone');
    await files.mkdir(user, '/', 'Docs');
    await files.mkdir(user, '/', 'Videos');

    await files.writeBuffer(user, '/', 'photo1.jpg', Buffer.from('identical photo bytes 1234567890'));
    await files.writeBuffer(user, '/Backups/Phone', 'photo2.jpg', Buffer.from('identical photo bytes 1234567890'));
    await files.writeBuffer(user, '/Docs', 'budget.rsheet', Buffer.from('sheet data'));

    // Large file (11MB)
    const largeBuf = Buffer.alloc(11 * 1024 * 1024, 0x42);
    await files.writeBuffer(user, '/Videos', 'big_clip.mp4', largeBuf);

    const stats = await getStorageAnalytics(files, user);

    assert.equal(stats.totalFiles, 4);
    assert.ok(stats.totalBytes > 11 * 1024 * 1024);
    assert.ok(stats.categories.videos > 10 * 1024 * 1024);
    assert.equal(stats.largeFiles.length, 1);
    assert.equal(stats.largeFiles[0].name, 'big_clip.mp4');

    // Duplicate detection check
    assert.equal(stats.duplicates.length, 1);
    assert.equal(stats.duplicates[0].files.length, 2);
    assert.ok(stats.duplicates[0].potentialSavings > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
