// Used by the Docker HEALTHCHECK: exits 0 if the server answers /api/status.
const http = require('node:http');
const https = require('node:https');

const useHttps = process.env.RDRIVE_HTTP !== '1';
const client = useHttps ? https : http;
const req = client.get(
  // The certificate is checked by real clients; here we only ask "is the process answering?".
  { host: '127.0.0.1', port: process.env.PORT || 8443, path: '/api/status', rejectUnauthorized: false, timeout: 4000 },
  (res) => process.exit(res.statusCode === 200 ? 0 : 1)
);
req.on('error', () => process.exit(1));
req.on('timeout', () => req.destroy());
