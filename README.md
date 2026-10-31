# rdrive

[![CI](https://github.com/CloudCorpRecords/rdrive/actions/workflows/ci.yml/badge.svg)](https://github.com/CloudCorpRecords/rdrive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An open-source, self-hosted alternative to Google Drive and Google Sheets. Run it on one machine: a PC, a Mac, a Linux box, a
Raspberry Pi or a NAS. Then sign in from your phone, laptop or any other device to upload, download, preview,
edit spreadsheets, share links and organise your files.

- **Your files stay as normal files** in `data/files/<username>/`, so you can back them up or open them directly.
- **Built-in RDocs:** write and format documents (`.rdoc`) in the browser, desktop or Android app: headings, bold/italic/underline, lists, links, tables, pictures, autosave, and PDF printing.
- **Built-in RDrive Sheets:** create and edit `.rsheet`, `.csv` and `.tsv` spreadsheets right in the browser or Android app, with formulas (`SUM`, `AVERAGE`, `IF`, `COUNTIF`, `SUMIF`, `ROUND`, cross-sheet references, etc.), multi-sheet tabs, formatting and sorting.
- **Works with Office, Google and LibreOffice files:** open Word (`.docx`), Excel (`.xlsx`) and OpenDocument (`.odt`, `.ods`) files, make an editable copy, and export back to `.docx`, `.xlsx`, `.odt`, `.ods`, Markdown, HTML, text or CSV. See [Documents and spreadsheets](#documents-and-spreadsheets).
- **Secure sign-in** with a password or **Sign in with GitHub** (single sign-on). Everything is encrypted with HTTPS.
- **Share links:** create expiring, optionally password-protected links to any file, folder or spreadsheet (with optional collaborative editing for spreadsheets).
- **Mount as a network drive (WebDAV):** mount `/dav/` in Windows Explorer, macOS Finder, Linux or mobile WebDAV clients.
- **Manage your devices:** see every phone and computer signed in to your account, and sign any of them out remotely.
- **Works on any device with a browser.** You can drag and drop files *and whole folders*, download any folder as a `.zip`, search across your drive, upload large files with
  progress bars, and preview images, video, audio, text and PDFs. You can rename, copy, move (including drag-to-folder)
  and delete. It has dark mode and a phone layout.
- **Deletes are recoverable:** deleted items go to `data/trash/<username>/` and can be restored or emptied right from the **Trash** view.
- **Multiple users**, each with their own private space.
- **Runs anywhere:** Docker images for x86-64 and ARM64, or plain Node.js on Windows, macOS and Linux.
- **Desktop and Android apps:** a Windows/macOS app that hosts your drive in the background (or opens a drive hosted
  elsewhere), and an Android app with "Share → rdrive", "New spreadsheet…", and automatic folder upload.
- **Small and auditable:** one runtime dependency, no database, and tested on every OS in CI.

## Documents and spreadsheets

**RDocs** (`+ Document`) and **RDrive Sheets** (`+ Spreadsheet`) are built in. They save automatically. Files are stored
as plain JSON (`.rdoc`, `.rsheet`), so they stay readable and easy to back up.

| You have | Open it in rdrive | Edit it | Export to |
|---|---|---|---|
| Word `.docx`, OpenDocument `.odt` | View, with formatting | **Edit a copy** creates an `.rdoc`; the original isn't changed | — |
| Markdown `.md`, `.txt`, `.html` | Text preview | Row menu → **Edit a copy in RDocs** | — |
| An RDoc (`.rdoc`) | RDocs editor | Directly | `.docx`, `.odt`, `.md`, `.html`, `.txt`, PDF (print) |
| Excel `.xlsx`, OpenDocument `.ods` | View, with formulas and formatting | **Edit a copy** creates an `.rsheet` | — |
| An RDrive Sheet (`.rsheet`) or `.csv`/`.tsv` | RDrive Sheets | Directly | `.xlsx`, `.ods` (all tabs, formulas, formatting), `.csv` |

Exports can be downloaded or saved as a copy in the same folder. Formulas keep working in Excel, Google Sheets and
LibreOffice: `.ods` files use OpenDocument formula syntax, and every formula carries its computed value. Moving to or
from Google Drive works through these formats. Google Docs and Sheets download and upload `.docx`/`.xlsx`.

Conversion happens in your browser using [mammoth](https://github.com/mwilliamson/mammoth.js),
[docx](https://github.com/dolanmiu/docx), [ExcelJS](https://github.com/exceljs/exceljs) and
[JSZip](https://github.com/Stuk/jszip). Their browser builds are in `public/vendor/` and load only when you import or
export. Refresh them with `npm run vendor`. Everything a document shows is filtered through an allowlist, so shared or
imported documents can't run scripts or load remote images.

Share links work for documents too. Tick **Allow anyone with the link to edit** to let people edit an `.rdoc` in their
browser, without an account.

## Apps

Download the latest builds from [Releases](https://github.com/CloudCorpRecords/rdrive/releases), or from the
newest run of the [Apps workflow](https://github.com/CloudCorpRecords/rdrive/actions/workflows/apps.yml)
(scroll to *Artifacts*).

### Desktop app (Windows and macOS)

On first launch it asks what this computer should do:

- **Host my drive here:** the app runs the rdrive server in the background, starts when you log in, and sits in
  the tray/menu bar. Your other devices connect to it. Point *Folder for your files* at an existing `data` folder to
  keep your accounts and files. Set *Drive address* to your Tailscale address, and run `tailscale serve --bg 8443` once.
- **Connect to my drive:** a dedicated window for a drive hosted on another computer. Enter its https address
  (for example `https://my-pc.my-tailnet.ts.net`).

The drive's window only shows your drive and GitHub's sign-in pages. Other links open in your browser, and certificate
errors are never ignored. Change the mode later from the tray icon → *Settings…*.

**macOS:** the app isn't notarized by Apple yet. The first time you open it, macOS will block it. Go to
System Settings → Privacy & Security, scroll down, and click **Open Anyway**.

### Android app

- **Share → rdrive** from any app (Photos, Files, WhatsApp…). Files go to the `Phone uploads` folder. If you're
  offline, they upload automatically when you're back online.
- **Auto-upload a folder** (menu ⋮ → *Auto-upload a folder…*), e.g. your Camera folder. New files are uploaded to
  `Phone/<folder>` about every 15 minutes. You choose whether files already in the folder are uploaded too. It only
  adds files: nothing is ever deleted on the phone or the drive.
- Browse, preview, upload and download, using the same drive as on your computer.

Install it: on the phone, open your drive in the browser, download the `.apk`, and tap it. Android will ask you to
allow installing apps from that browser. If your drive uses Tailscale, install the Tailscale app on the phone and sign
in to the same account first.

Building it yourself: `cd android && ./gradlew assembleRelease` (needs the Android SDK). To sign release builds with
your own key, create `~/.rdrive-android/keystore.properties` with `storeFile`, `storePassword`, `keyAlias` and
`keyPassword`. Without it, builds are signed with the debug key.

## Install

### Option A: Docker (Linux, NAS, Raspberry Pi, or Docker Desktop on Windows/Mac)

```bash
curl -O https://raw.githubusercontent.com/CloudCorpRecords/rdrive/main/docker-compose.yml
```

```bash
docker compose up -d
```

```bash
docker compose exec -it rdrive node server.js adduser yourname
```

Open `https://<that-machine's-address>:8443` and sign in. Images are published to
`ghcr.io/cloudcorprecords/rdrive` for `linux/amd64` and `linux/arm64` (Raspberry Pi 3/4/5 running a 64-bit OS,
and most NAS boxes).

### Option B: Node.js (Windows, macOS, Linux)

You need [Node.js](https://nodejs.org) 22.9 or newer. Settings can go in a `.env` file (copy
[.env.example](.env.example)), which `npm start` reads automatically.

```bash
git clone https://github.com/CloudCorpRecords/rdrive
```

```bash
cd rdrive
npm install --omit=dev
npm start
```

Open **https://localhost:8443** on that machine and create your account there. For safety, the first account can
only be created from the machine itself. You can also create accounts from the terminal with `npm run adduser -- yourname`.

To keep it running in the background:
- **Linux / Raspberry Pi:** use the systemd unit in [docs/rdrive.service](docs/rdrive.service). Its header has the commands.
- **Windows:** in Task Scheduler, create a task "At log on" (or "At startup") that runs `node` with the argument
  `server.js`, starting in the rdrive folder.
- **macOS:** `brew services`, `pm2`, or a LaunchAgent all work. Or use Docker Desktop.

### The certificate warning

With no other setup, rdrive makes its own HTTPS certificate, so browsers warn the first time. When it starts,
the server prints the certificate's fingerprint. Check that it matches what your browser shows, then continue.
To avoid the warning entirely, use Tailscale (below), which gives you a real certificate. You can also put your own
`cert.pem` and `key.pem` in `data/tls/`.

## Connecting your devices

### Same Wi-Fi / home network

The server prints addresses like `https://10.0.0.215:8443`. Open one on your other devices. On Windows, allow
Node.js through the firewall the first time it asks ("Private networks").

### From anywhere (recommended: Tailscale)

**Don't port-forward rdrive on your router.** [Tailscale](https://tailscale.com) (free for personal use) creates a
private, encrypted network that only your own devices can join, and gives rdrive a real HTTPS address:

1. Install Tailscale on the rdrive machine and on each device. Sign in to the same account on all of them.
2. Run rdrive so it's only reachable through Tailscale:

   ```powershell
   $env:RDRIVE_HTTP = '1'; $env:HOST = '127.0.0.1'; npm start
   ```

   ```bash
   tailscale serve --bg 8443
   ```

3. Open `https://<machine-name>.<your-tailnet>.ts.net` on any of your devices.

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or a VPN into your
home network work too. Behind any reverse proxy, set `RDRIVE_HTTP=1` and `RDRIVE_TRUST_PROXY=1`, and make sure the
proxy uses HTTPS.

## Sign in with GitHub (SSO)

GitHub proves who someone is, and rdrive decides whether they're allowed in. **Only GitHub accounts you've linked
to an rdrive user can sign in**, so a stranger with a GitHub account gets "not allowed". rdrive only asks GitHub for
your public profile (your user id). It never sees your GitHub password and never stores GitHub tokens.

1. **Pick one address you'll always use for rdrive**, for example `https://rdrive.your-tailnet.ts.net`. Sign-in
   comes back to this address. It does *not* need to be reachable from the internet: only your browser visits it.
2. **Create a GitHub OAuth App:** go to GitHub → Settings → Developer settings → OAuth Apps → *New OAuth App*
   ([direct link](https://github.com/settings/applications/new)).
   - Homepage URL: your address, e.g. `https://rdrive.your-tailnet.ts.net`
   - Authorization callback URL: your address + `/auth/github/callback`
   - Click *Register*, then *Generate a new client secret*.
3. **Start rdrive with these settings:**

   ```powershell
   $env:RDRIVE_PUBLIC_URL = 'https://rdrive.your-tailnet.ts.net'
   $env:RDRIVE_GITHUB_CLIENT_ID = 'Ov23li...'
   $env:RDRIVE_GITHUB_CLIENT_SECRET = '...'
   npm start
   ```

   (With Docker, set the same three variables in `docker-compose.yml`. With systemd, put them in `/etc/rdrive.env`.)
   Treat the client secret like a password.
4. **Allow GitHub accounts**, in one of three ways:
   - In the web app, sign in with your password, click your name → **Link GitHub account**.
   - From a terminal, give an existing user GitHub sign-in: `npm run link-github -- yourname your-github-username`
   - Or create a GitHub-only user (no password at all): `npm run adduser-github -- alice alice-on-github`

Turn on two-factor authentication in your GitHub account: your rdrive is then protected by it too.

## AI Agents (Model Context Protocol / MCP)

Each user can grant AI agents (Claude, Antigravity, Cursor, or custom agents) scoped access to their own files and spreadsheets over the **Model Context Protocol (MCP)**—without ever sharing passwords or exposing other users' data.

### Per-individual security guarantees
- **Per-user isolation:** Every Personal Agent Token (`rdrive_pat_...`) belongs to a single rdrive user and is strictly confined to `data/files/<username>/`.
- **Hashed on disk:** Raw tokens are shown only once when created; the server stores only their SHA-256 hashes in `data/tokens.json`.
- **Permission scopes (`read` vs `write`):** Create a `read`-only token if the agent should only list, search, and read files/spreadsheets, or a `write` token to let it create/edit spreadsheets and files.
- **Folder confinement:** Optionally restrict a token to a single subfolder (e.g. `/AI Workspace`) so the agent cannot see or touch anything else in your drive.
- **Safe deletes:** Even with `write` access, `drive_trash` only moves items to your recoverable Trash—agents can never permanently delete files or empty your trash.

### Connecting an AI agent
1. In the web app, click your username → **AI Agents (MCP Server)** → **New agent token…** (or run `npm run add-token -- <username> "My Agent" write /`).
2. Connect using **Streamable HTTP** (`/mcp`):
   ```json
   {
     "mcpServers": {
       "rdrive": {
         "url": "https://your-machine.your-tailnet.ts.net/mcp",
         "headers": {
           "Authorization": "Bearer rdrive_pat_..."
         }
       }
     }
   }
   ```
3. Or connect over **stdio** using `mcp.js`:
   ```json
   {
     "mcpServers": {
       "rdrive": {
         "command": "node",
         "args": ["/path/to/rdrive/mcp.js"],
         "env": {
           "RDRIVE_URL": "https://your-machine.your-tailnet.ts.net",
           "RDRIVE_TOKEN": "rdrive_pat_..."
         }
       }
     }
   }
   ```

## Managing signed-in devices

Click your name in the top-right corner. **Signed-in devices** lists each device: browser and OS, IP address, when it
was last active, and whether it signed in with a password or GitHub. **Sign out** ends one device's session immediately.
**Sign out all others** keeps only the device you're using. Changing your password also signs out every other device.
Sessions expire after 30 days.

## Sync between several servers

Run rdrive on more than one machine (say a home server and a laptop) and link them, so the same accounts have the
same files on each. Every server keeps a full copy and works on its own while the others are offline.

1. **Make the servers reachable from each other over https.** Tailscale is the easiest way (see above). Each server's
   own self-signed certificate is fine: it's pinned when you link.
2. **Create the same usernames on each server.** Only accounts whose username exists on both servers sync. Passwords
   and signed-in devices are not synced.
3. On the first server, as the **owner** (the first account you created), click your name → **Linked servers** →
   **Show pairing code**.
4. On the second server, as its owner, click **Link a server…** and enter:
   - the first server's address, e.g. `https://home-server.tailnet-name.ts.net:8443`
   - the code from step 3 (it works once, for 10 minutes)
   - this server's own address, as the first one reaches it (it's filled in with the address in your browser)
5. Both servers now list each other. Files sync within seconds after a change made in the web app, and every minute
   otherwise. Files changed directly on disk in `data/files/` are picked up too.

How changes are handled:

- **Edits, new files, renames and moves** are copied to the other servers.
- **Deletes** move the item to the other servers' trash, so nothing is lost for good.
- **Conflicts.** If the same file was changed on two servers before they synced, both versions are kept. The newer
  one keeps the name, and the other becomes `name (conflict from <server> <date>).ext`, the same on every server.
  If one server edits a file while another deletes it, the edit wins.
- **Large files** are downloaded with resume and checked against a SHA-256 hash before they replace anything.

To make another account the owner: `npm run set-owner -- NAME`. To stop syncing, click **Unlink**. Nothing is deleted
on either server. The details and security design are in [docs/sync.md](docs/sync.md).

## User management (terminal)

| Command | What it does |
|---|---|
| `npm run users` | List users and how each can sign in |
| `npm run adduser -- NAME` | Create a user with a password |
| `npm run adduser-github -- NAME GH_USER` | Create a user who signs in only with GitHub |
| `npm run link-github -- NAME GH_USER` | Let an existing user also sign in with GitHub |
| `npm run unlink-github -- NAME` | Remove GitHub sign-in (the user must have a password) |
| `npm run passwd -- NAME` | Set or reset a password (signs them out everywhere) |
| `npm run set-owner -- NAME` | Make NAME the owner (the account that can link servers for sync) |
| `npm run deluser -- NAME` | Remove a user (their files stay on disk) |

With Docker, run `docker compose exec -it rdrive node server.js <command> ...` instead.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8443` | Port to listen on |
| `HOST` | `0.0.0.0` | `0.0.0.0` = reachable from your network; `127.0.0.1` = this machine only |
| `RDRIVE_DATA` | `./data` (`/data` in Docker) | Where files, accounts and the certificate are stored |
| `RDRIVE_HTTP` | unset | `1` = plain HTTP. **Only** behind something that already encrypts (Tailscale, a reverse proxy) |
| `RDRIVE_TRUST_PROXY` | unset | `1` = read the client IP from `X-Forwarded-For` (only behind a proxy you control) |
| `RDRIVE_PUBLIC_URL` | unset | The address people use for rdrive. Needed for GitHub sign-in |
| `RDRIVE_GITHUB_CLIENT_ID` / `RDRIVE_GITHUB_CLIENT_SECRET` | unset | Turn on GitHub sign-in |
| `RDRIVE_SERVER_NAME` | the computer's name | How this server is named to linked servers and in conflict copies |
| `RDRIVE_SYNC_INTERVAL` | `60` | Seconds between sync checks with linked servers (changes made in the web app sync sooner) |

## What's in `data/`

```
data/
  files/<user>/     your files, as normal files and folders
  trash/<user>/     deleted items (timestamp__name). Empty it by hand when you want the space back
  users.json        users, scrypt password hashes, linked GitHub ids
  sessions.json     signed-in devices (tokens are stored hashed)
  tokens.json       AI agent (MCP) tokens: owner, scope, folder, expiry (tokens are stored hashed)
  shares.json       share links: path, expiry, optional scrypt password hash
  trash/<user>.meta.json  where each trashed item came from, for restore
  tls/              HTTPS certificate and private key
  peers.json        linked servers: address, pinned certificate, shared secret
  sync/             this server's sync id, what each linked server last agreed on, hash cache, partial downloads
```

Back up `data/files` like any other folder. Keep `data/` private: never commit it or share it.

## Security model

- Passwords are hashed with scrypt. Login timing doesn't reveal whether a username exists.
- After 5 failed logins (including unknown GitHub accounts), that IP address is locked out for 15 minutes.
- Session cookies are random 256-bit tokens, `HttpOnly`, `SameSite=Strict` and `Secure`. The server stores only their
  SHA-256 hashes.
- GitHub sign-in uses the OAuth web flow with a single-use `state`, PKCE, and a cookie that binds the flow to the
  browser that started it. Accounts are matched by GitHub's permanent numeric id, not the username, which can change.
- The first account can only be created from the machine itself.
- Each user is confined to their own folder. All paths are validated, and `..`, drive letters, NTFS streams and similar
  tricks are rejected.
- CSRF protection: `SameSite=Strict` cookies, plus a custom header that's required on every change.
- HTML and SVG files are always downloaded, never rendered. A strict Content-Security-Policy and other hardening
  headers are set on every response.
- Sync: servers pair with a single-use code that never crosses the network (it signs a proof bound to both
  certificates). After that, every request between servers is signed with a per-server secret and can't be replayed,
  and self-signed certificates are pinned. Linked servers can only read from each other, never write, and every path
  they send is checked like a user's.

Found a problem? Please report it privately. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm test
```

The code layout: `server.js` (routes and CLI), `lib/auth.js` (users, passwords, sessions), `lib/github.js`
(GitHub sign-in), `lib/files.js` (file operations, search, trash restore and path safety), `lib/shares.js`
(expiring and password-protected share links), `lib/zip.js` (streaming folder `.zip` downloads),
`lib/webdav.js` (WebDAV network drive mount at `/dav/`), `lib/sync.js` (server-to-server sync),
`lib/tls.js` (certificates), `public/` (the web app and `public/sheet.js` spreadsheet editor: plain HTML/CSS/JS, no build step). See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- More SSO providers (generic OpenID Connect: Google, Microsoft, Authentik, Keycloak)
- Real-time co-editing and version history for documents and spreadsheets
- Editing `.docx`/`.xlsx` files in place (today: edit a copy, then export)

## License

MIT. See [LICENSE](LICENSE).
