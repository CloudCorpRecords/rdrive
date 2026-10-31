'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { Files } = require('../lib/files');
const { getPhotosTimeline, isMedia, isVideo } = require('../lib/photos');

test('photos timeline: scans media, groups chronologically, and detects devices', async () => {
  const tmp = path.join(os.tmpdir(), `rdrive-photos-test-${Date.now()}`);
  const user = 'photouser';
  const files = new Files(tmp);
  const userDir = files.userRoot(user);

  // Create sample folder structure:
  // /Photos/pic1.jpg
  // /Backups/Pixel 9/DCIM/2026-10/Screenshot_20261025_Claude.jpg
  // /Backups/Galaxy S25/DCIM/2025-11/video.mp4
  // /Docs/notes.txt (should NOT be collected)
  const p1 = path.join(userDir, 'Photos');
  const p2 = path.join(userDir, 'Backups', 'Pixel 9', 'DCIM', '2026-10');
  const p3 = path.join(userDir, 'Backups', 'Galaxy S25', 'DCIM', '2025-11');
  const p4 = path.join(userDir, 'Docs');

  await fsp.mkdir(p1, { recursive: true });
  await fsp.mkdir(p2, { recursive: true });
  await fsp.mkdir(p3, { recursive: true });
  await fsp.mkdir(p4, { recursive: true });

  await fsp.writeFile(path.join(p1, 'camera_photo.jpg'), 'fake-image-bytes');
  await fsp.writeFile(path.join(p2, 'Screenshot_20261025_Claude.jpg'), 'fake-image-bytes');
  await fsp.writeFile(path.join(p3, 'sample_clip.mp4'), 'fake-video-bytes');
  await fsp.writeFile(path.join(p4, 'notes.txt'), 'text file');

  assert.strictEqual(isMedia('test.jpg'), true);
  assert.strictEqual(isMedia('test.png'), true);
  assert.strictEqual(isMedia('test.mp4'), true);
  assert.strictEqual(isVideo('test.mp4'), true);
  assert.strictEqual(isVideo('test.jpg'), false);
  assert.strictEqual(isMedia('notes.txt'), false);

  const timeline = await getPhotosTimeline(files, user);

  assert.strictEqual(timeline.total, 3, 'Should find exactly 3 media files');
  assert.strictEqual(timeline.stats.photosCount, 2);
  assert.strictEqual(timeline.stats.videosCount, 1);

  // Check device recognition
  const pixelItem = timeline.groups.flatMap((g) => g.items).find((i) => i.name.includes('Claude'));
  assert.ok(pixelItem);
  assert.strictEqual(pixelItem.device, 'Pixel 9');

  const s25Item = timeline.groups.flatMap((g) => g.items).find((i) => i.name.includes('sample_clip'));
  assert.ok(s25Item);
  assert.strictEqual(s25Item.device, 'Galaxy S25');
  assert.strictEqual(s25Item.isVideo, true);

  // Test filter videos only
  const videosOnly = await getPhotosTimeline(files, user, { filter: 'videos' });
  assert.strictEqual(videosOnly.total, 1);
  assert.strictEqual(videosOnly.groups[0].items[0].name, 'sample_clip.mp4');

  // Test filter backups only
  const backupsOnly = await getPhotosTimeline(files, user, { filter: 'backups' });
  assert.strictEqual(backupsOnly.total, 2);

  await fsp.rm(tmp, { recursive: true, force: true });
});
