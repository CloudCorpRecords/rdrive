# rdrive

An open-source, self-hosted alternative to Google Drive. Run it on one computer, then sign in from your
phone, laptop or any other device to upload, download, preview and organise files.

- **Your files stay as normal files** in `data/files/<username>/`, so you can back them up or open them directly.
- **Secure sign-in.** Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Strict cookies.
  Failed logins are rate-limited, and all traffic is encrypted with HTTPS.
- **Works on any device with a browser.** You can drag and drop files *and whole folders*, upload large
  files with progress bars, and preview images, video, audio, text and PDFs. You can rename, move (including
  drag-to-folder) and delete. It has dark mode and a phone layout.
- **Deletes are recoverable:** deleted items go to `data/trash/<username>/`.
- **Multiple users**, each with their own private space.
- **Small:** Node.js plus one dependency (for generating the HTTPS certificate). No database.

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
npm start
```

Open **https://localhost:8443** on the computer running rdrive. Your browser will warn about the certificate.
That's expected: rdrive made its own certificate. Compare the fingerprint the server printed in the terminal,
then continue. Create your account. For safety, the first account can only be created from that computer.

To add more accounts later (for example for family members):

```bash
npm run adduser -- alice
```

Other commands: `npm run passwd -- alice` changes a password and signs that user out everywhere.
`npm run deluser -- alice` removes the account but keeps the files. `npm run users` lists accounts.

## Connecting your other devices

### On the same Wi-Fi / home network

When the server starts, it prints addresses like `https://10.0.0.215:8443`. Open one on your phone or other
computer and accept the certificate warning once (check the fingerprint). On Windows, allow Node.js through the
firewall the first time it asks ("Private networks").

### From anywhere (recommended: Tailscale)

**Do not open a port on your router.** The safest way to reach rdrive from outside your home is
[Tailscale](https://tailscale.com) (free for personal use). It creates a private, encrypted network that
only your own devices can join.

1. Install Tailscale on the rdrive computer and on each device, and sign in to the same account on all of them.
2. Run rdrive so it's only reachable through Tailscale, which gives you a real HTTPS certificate (no browser
   warnings):

   ```powershell
   $env:RDRIVE_HTTP = '1'; $env:HOST = '127.0.0.1'; npm start
   ```

   ```bash
   tailscale serve --bg 8443
   ```

3. Open the `https://<computer-name>.<tailnet>.ts.net` address that Tailscale prints, from any of your devices.

Alternatives: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or
a VPN into your home network. If you put rdrive behind any other reverse proxy, make sure the proxy uses HTTPS.

## Configuration

Set these as environment variables:

| Variable       | Default        | What it does                                                                 |
|----------------|----------------|------------------------------------------------------------------------------|
| `PORT`         | `8443`         | Port to listen on                                                            |
| `HOST`         | `0.0.0.0`      | `0.0.0.0` = reachable from your network; `127.0.0.1` = this computer only    |
| `RDRIVE_DATA`  | `./data`       | Where files, accounts and the certificate are stored (e.g. a big external drive) |
| `RDRIVE_HTTP`  | (unset)        | Set to `1` to serve plain HTTP. **Only** use this behind something that already encrypts, like `tailscale serve` |

To use your own certificate, put `cert.pem` and `key.pem` in `data/tls/`.

## What's in `data/`

```
data/
  files/<user>/     your files, as normal files and folders
  trash/<user>/     deleted items (timestamp__name). Empty it by hand when you want the space back
  users.json        usernames + scrypt password hashes
  sessions.json     active sign-ins (stored hashed)
  tls/              HTTPS certificate and private key
```

Back up `data/files` like any other folder. Keep `data/` private: never commit it or share it.

## Security model, in brief

- The first account can only be created from the machine itself (loopback, not proxied).
- Each user is confined to their own folder. Paths are validated and `..` and other tricks are rejected (see tests).
- CSRF protection: SameSite=Strict cookies, plus a custom header that's required on every change.
- After 5 failed logins, that IP address is locked out for 15 minutes. Behind `tailscale serve`, every request
  looks like it comes from the same address, so this limit is shared. That's fine there, because only your own
  devices can connect.
- HTML/SVG files are always downloaded, never rendered, so an uploaded file can't run scripts in rdrive's page.
- Strict Content-Security-Policy and other hardening headers.

## Development

```bash
npm test
```

The code layout: `server.js` (HTTP routes + CLI), `lib/auth.js` (accounts and sessions), `lib/files.js`
(file operations and path safety), `lib/tls.js` (certificates), `public/` (the web app: plain HTML/CSS/JS,
no build step).

## Ideas for later

- Share links (public, expiring links to a single file)
- Download a folder as .zip
- Search, and a trash view in the UI with restore
- Desktop sync client / WebDAV support so the drive can be mounted like a network drive
- Storage quotas per user

## License

MIT, see [LICENSE](LICENSE).
