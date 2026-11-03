const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VaultManager } = require('../lib/vault');

test('vault manager: PIN setup, unlocking, invalid PIN, lock, and path check', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdrive-vault-test-'));
  try {
    const mgr = new VaultManager(tmp);
    const user = 'alice';

    assert.equal(mgr.hasPin(user), false);
    assert.equal(mgr.isVaultPath('/Vault'), true);
    assert.equal(mgr.isVaultPath('/Vault/Secret.pdf'), true);
    assert.equal(mgr.isVaultPath('/Documents/Notes.txt'), false);

    // Set PIN
    await mgr.setPin(user, '1234');
    assert.equal(mgr.hasPin(user), true);

    // Wrong PIN
    const fail = mgr.unlock(user, '9999');
    assert.equal(fail, null);

    // Correct PIN
    const session = mgr.unlock(user, '1234');
    assert.ok(session.token);
    assert.ok(session.expiresAt > Date.now());

    // Valid session check
    assert.equal(mgr.isUnlocked(user, session.token), true);
    assert.equal(mgr.isUnlocked('bob', session.token), false);

    // Explicit lock
    mgr.lock(session.token);
    assert.equal(mgr.isUnlocked(user, session.token), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
