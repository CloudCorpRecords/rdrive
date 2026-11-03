const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { StarredManager } = require('../lib/starred');

test('starred manager: star, unstar, list, and rename propagation', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-starred-test-'));
  try {
    const mgr = new StarredManager(tmp);
    const user = 'testuser';

    // Initial empty
    assert.deepEqual(mgr.list(user), []);
    assert.equal(mgr.isStarred(user, '/Projects/Q4.rsheet'), false);

    // Toggle star on
    const r1 = await mgr.toggle(user, '/Projects/Q4.rsheet');
    assert.equal(r1.starred, true);
    assert.equal(mgr.isStarred(user, '/Projects/Q4.rsheet'), true);

    // Add another star
    await mgr.toggle(user, '/Important/Notes.rdoc');
    assert.equal(mgr.list(user).length, 2);

    // Toggle off
    const r2 = await mgr.toggle(user, '/Projects/Q4.rsheet');
    assert.equal(r2.starred, false);
    assert.equal(mgr.isStarred(user, '/Projects/Q4.rsheet'), false);
    assert.equal(mgr.list(user).length, 1);

    // Rename propagation
    await mgr.toggle(user, '/Work/Docs/Specs.rdoc');
    await mgr.rename(user, '/Work', '/Archive/Work');
    assert.equal(mgr.isStarred(user, '/Work/Docs/Specs.rdoc'), false);
    assert.equal(mgr.isStarred(user, '/Archive/Work/Docs/Specs.rdoc'), true);

    // Persistence reload test
    const mgr2 = new StarredManager(tmp);
    assert.equal(mgr2.isStarred(user, '/Archive/Work/Docs/Specs.rdoc'), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
