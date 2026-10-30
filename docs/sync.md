# Server-to-server sync (design)

Status: **implemented** in `lib/sync.js`, with routes in `server.js` and tests in `test/sync.test.js`. Setup steps are
in the README.

Goal: several machines each run rdrive and keep the same users' files in sync, without adding
dependencies, a database, or any endpoint that works without authentication.

## Summary

- Servers pair once with a **one-time code**. Pairing creates a **per-peer secret**. Every later
  request is signed with HMAC-SHA256 over that secret. Self-signed certificates are **pinned**.
- Sync is **pull-only**. Each server reads its peers' file lists and copies what changed onto its own
  disk. No peer can ever write to another server: the inbound sync endpoints are read-only.
- Change detection is a **periodic scan with content hashes** plus a per-peer "last agreed state"
  (the base). Comparing local, remote and base gives a three-way merge.
- Conflicts keep both copies. Deletes go to the trash. Only usernames that exist on both servers sync.
- Large files download into a part file, resume with `Range`, and are checked against the expected
  SHA-256 before they replace anything.

## Who can pair

Pairing affects every account on the server, so only the **owner** can do it. The first account
created gets `owner: true` in `users.json`. On installs from before this flag existed, the oldest
account is the owner. `node server.js set-owner NAME` moves the flag. Other users can see the linked
servers but not the controls.

## Pairing

1. On server **A**, the owner opens Account → Linked servers → **Show pairing code**. A creates a random
   code of 100 bits, shown as `XXXXX-XXXXX-XXXXX-XXXXX` (base32). It is valid for **10 minutes**, can be
   used **once**, and only one code can be active at a time. A also shows its certificate fingerprint.
2. On server **B**, the owner opens Linked servers → **Link a server** and enters A's URL and the code.
3. B connects to A once to read its certificate. If the system trusts it, `fpA_seen` is empty and normal
   validation is used from then on. Otherwise B pins that certificate and records its fingerprint as
   `fpA_seen`. B then sends
   `POST /sync/pair`:
   `{ id: B.id, name: B.name, url: B.url, fp: fpB, nonce, proof }`, where
   `proof = HMAC(code, "rdrive-pair-v1" | B.id | B.url | fpB | fpA_seen | nonce)`.
   **The code itself is never sent.**
4. A recomputes `proof` using its own fingerprint (or an empty one if B says it did not pin) and compares in constant time. A man-in-the-middle
   would present a different certificate, so `fpA_seen` would not match and the proof would fail.
   Without the code, nobody can forge the proof. After 5 wrong attempts the code is burned, and
   the endpoint shares the existing per-IP lockout.
5. A creates a 32-byte `secret`, stores the peer (`id, name, url, fpB, secret`) and replies with
   `{ id: A.id, name: A.name, secret: enc, mac }`. Here `enc` is the secret XORed with
   `HKDF(code, nonce)` and `mac = HMAC(code, …response…)`. This way the secret is protected even if
   TLS were somehow broken, and B can tell the reply really came from A.
6. B stores the peer (`id, name, url, fpA_seen, secret`). Both sides now list each other.

Running behind `tailscale serve` (`RDRIVE_HTTP=1`): A does not know its own certificate. In that case
the peer's URL must be `https://` with a certificate that the system trusts (Tailscale provides one),
`fpA` is left empty, and normal CA validation applies in place of pinning.

### Requests after pairing

All `/sync/*` routes except `/sync/pair` need this header:

```
Authorization: RdriveSync id=<senderId>, ts=<unix ms>, nonce=<16 bytes hex>, sig=<hex>
sig = HMAC-SHA256(secret, METHOD \n path?query \n senderId \n ts \n nonce \n sha256(body))
```

The receiver rejects a request if the sender id is unknown, `ts` is more than 5 minutes off, the nonce was
already seen (nonces are kept in memory for 10 minutes), or the signature fails a constant-time check.
Unknown or missing signatures get a plain `401` and count toward the IP lockout. For outgoing requests to a
pinned peer, the pinned certificate is the only trusted CA, and the TLS handshake also checks its exact SHA-256
fingerprint. So nothing, signed headers included, is ever sent to a server that presents a different certificate.
If a peer's certificate changes (for example, it was regenerated), unlink it and pair again.

**Unlinking** deletes the peer and its secret on this side and sends a signed, best-effort `POST /sync/unpair`
so the other side drops it too.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /sync/pair` | pairing proof | one-time pairing (above) |
| `POST /sync/unpair` | signed | the peer drops us |
| `GET /sync/manifest?user=` | signed | `[{path, type, size, mtime, sha256}]` for that user, or `404` if the username doesn't exist here |
| `GET /sync/file?user=&path=&sha256=` | signed | file bytes with `Range`. Returns `409` if the hash no longer matches |
| `POST /sync/nudge` | signed | "something changed, pull from me soon" |
| `/api/sync/*` | owner session + `X-Rdrive` | UI: show code, link, unlink, list peers, sync now |

`/sync/*` sits outside `/api/`, so browsers never send cookies there in a way that matters. These routes
also ignore cookies completely.

## Change detection

Files are plain files, and people may edit `data/files/` directly. A journal would miss those edits,
so each sync pass **scans** the user's folder. To avoid re-hashing everything, a hash cache
(`data/sync/hashes/<user>.json`, keyed by path + size + mtime) means only new or changed files get
re-hashed. After a local change through the web UI, rdrive sends a nudge to its peers. Otherwise it
syncs every `RDRIVE_SYNC_INTERVAL` seconds (default 60).

For each peer and user, `data/sync/base/<peerId>/<user>.json` records the state both sides last agreed on
(path → sha256 or `folder`). Each pass compares **L** (local), **R** (remote) and **B** (base) for every path:

| Case | Action |
|---|---|
| L = R | nothing |
| R ≠ B, L = B | apply remote: download, create the folder, or trash the local copy |
| L ≠ B, R = B | nothing. The peer will pull from us |
| L ≠ B, R ≠ B, L ≠ R, both exist | **conflict** |
| remote deleted, local changed | keep local (an edit beats a delete) |

After each path is resolved, the base records the agreed value.

**Renames** show up as one path disappearing and another appearing with the same hash. If the hash
already exists locally at the old path and that copy is unchanged, rdrive moves it instead of
downloading it again.

Before overwriting or trashing, rdrive hashes the local file once more. If it changed since the scan,
that path is skipped and retried on the next pass, which closes the race with a user who is uploading at the same moment.

## Conflicts

Neither copy is ever overwritten. Both servers pick the same winner: the version with the newer mtime, or the
higher hash if the mtimes are equal. The winner keeps the original name. The other version is saved next to it as
`name (conflict from <server> <YYYY-MM-DD>).ext`, where `<server>` is the server that had that version and the
date is that version's mtime. Because both servers compute the same names, they end up with identical files
rather than conflict copies of conflict copies. `<server>` is the server's name, cleaned so it passes
`validateName`.

If the remote item is a file and the local one is a folder, the file gets the conflict name. In the reverse case
(a folder there, a file here), that subtree is skipped and an error is shown until someone renames one of them.

## Deletes

When a remote delete is applied, the local item goes to `data/trash/<user>/` through `Files.trash`, so it can
be recovered. Nothing is ever permanently deleted by sync. A folder is trashed as a whole only when nothing
under it changed locally. Otherwise only the unchanged items are trashed.

## Accounts

A user syncs only if the **same username exists on both servers**. Users that exist on one server only are
ignored, and sync never creates accounts. Passwords, sessions and GitHub links are not synced. Each server
keeps its own.

## Interrupted transfers

A download goes to `data/sync/partial/<peerId>/<sha256>.rdrive-part`. On the next attempt, rdrive asks for
`Range: bytes=<size of part>-`, along with `sha256=` so the peer refuses the request if the file changed in
the meantime. Once the download finishes, the hash is verified. Then the file is renamed into place under the
user's folder, and its mtime is set to the remote mtime. Part files older than 7 days are removed.

## Security notes

- Every inbound sync route needs the per-peer signature, apart from pairing, which needs proof of the code.
- Peers can only **read** each other. A compromised peer can send bad data (fake manifests, wrong bytes),
  but every path it sends passes through `validateName` and `Files.resolve`, and every file is checked
  against the declared hash. It can therefore only affect the files of users who exist on both servers,
  and those changes can be recovered from the trash or from the conflict copies.
- Per-peer secrets are kept in `data/peers.json` with mode 0600, like `users.json`. Both sides need the
  raw secret to compute the HMAC.
- Rate limiting applies. `/sync/pair` and failed signatures use the existing per-IP failure lockout.
- New files: `data/sync/` holds the server id, base snapshots, the hash cache and part files, and
  `data/peers.json` holds the peers.

## Out of scope for v1

Syncing users, passwords or shares. Limiting a peer to some of the shared usernames. Block-level deltas,
where only the changed parts of a file are sent. Paths that differ only by case, on case-insensitive disks.
Automatic discovery of peers. A compromised peer that drops files from its list can still make other servers
trash them. The files can be recovered from the trash, but this is a reason to link only servers you control.
