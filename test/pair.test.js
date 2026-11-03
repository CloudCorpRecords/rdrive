const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DevicePairing } = require('../lib/pair');

test('link token: creation, claim, single-use, and expiration', () => {
  const p = new DevicePairing();
  const token = p.createLinkToken('alice');
  assert.ok(typeof token === 'string' && token.length === 64);

  // First claim succeeds
  const claim = p.claimLinkToken(token);
  assert.deepEqual(claim, { user: 'alice', meta: {} });

  // Second claim fails (single use)
  assert.equal(p.claimLinkToken(token), null);

  // Expired token fails
  const token2 = p.createLinkToken('bob');
  p.links.get(token2).expiresAt = Date.now() - 1000;
  assert.equal(p.claimLinkToken(token2), null);
});

test('code flow: request, approve, and status polling', () => {
  const p = new DevicePairing();
  const req = p.createCodeRequest();
  assert.ok(req.id);
  assert.match(req.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  assert.equal(req.expiresIn, 300);

  // Before approval, status is pending
  assert.deepEqual(p.checkCodeStatus(req.id), { status: 'pending' });

  // Wrong code fails to approve
  assert.equal(p.approveCode('WRONG-123', 'alice'), false);

  // Approving with lowercase and no hyphen works
  const unhyphenated = req.code.replace('-', '').toLowerCase();
  assert.equal(p.approveCode(unhyphenated, 'alice'), true);
  // ...but only once
  assert.equal(p.approveCode(req.code, 'mallory'), false);

  // Poll status now returns approved for that user
  assert.deepEqual(p.checkCodeStatus(req.id), { status: 'approved', user: 'alice' });

  // Second poll returns expired / not found (single use)
  assert.deepEqual(p.checkCodeStatus(req.id), { status: 'expired' });
});

test('code flow: expired request cannot be approved', () => {
  const p = new DevicePairing();
  const req = p.createCodeRequest();
  p.requests.get(req.id).expiresAt = Date.now() - 1000;

  assert.equal(p.approveCode(req.code, 'alice'), false);
  assert.deepEqual(p.checkCodeStatus(req.id), { status: 'expired' });
});

test('code flow: pending codes are capped per address', () => {
  const p = new DevicePairing();
  for (let i = 0; i < 5; i++) assert.ok(p.createCodeRequest('10.0.0.1'));
  assert.equal(p.createCodeRequest('10.0.0.1'), null);
  assert.ok(p.createCodeRequest('10.0.0.2'));
});

test('status for an unknown or malformed id is expired', () => {
  const p = new DevicePairing();
  assert.deepEqual(p.checkCodeStatus('nope'), { status: 'expired' });
  assert.deepEqual(p.checkCodeStatus(undefined), { status: 'expired' });
  assert.deepEqual(p.checkCodeStatus({}), { status: 'expired' });
});
