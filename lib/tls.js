// HTTPS certificate handling. Uses data/tls/cert.pem + key.pem if present
// (drop in your own, e.g. from Tailscale or Let's Encrypt); otherwise creates a self-signed one.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      // Skip 169.254.x.x: self-assigned addresses that other devices can't usually reach.
      if (!a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

function loadOrCreateCert(dataDir) {
  const dir = path.join(dataDir, 'tls');
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const cert = fs.readFileSync(certFile);
    return { cert, key: fs.readFileSync(keyFile), fingerprint: fingerprint(cert), generated: false };
  }

  const selfsigned = require('selfsigned');
  const hostname = os.hostname();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: hostname },
    { type: 2, value: `${hostname}.local` },
    { type: 7, ip: '127.0.0.1' },
    ...lanAddresses().map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: `rdrive on ${hostname}` }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private, fingerprint: fingerprint(pems.cert), generated: true };
}

// SHA-256 fingerprint, so you can check you're talking to your own server when the browser warns.
function fingerprint(certPem) {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

module.exports = { loadOrCreateCert, lanAddresses };
