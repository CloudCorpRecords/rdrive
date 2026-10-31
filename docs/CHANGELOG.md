# Changelog

Write what changed under a new `## x.y.z` heading at the top, then run `npm run release -- x.y.z`.
The section becomes the release notes.

## 0.5.2

- **New look: Night garden.** Deep green-black with soft mint at night, calm sage in light mode, rounded
  shapes, and each kind of file in its own color, with photo thumbnails.
- **Made for phones.** A + button for new documents, spreadsheets, folders, uploads and photos. A bottom bar
  for Files, Search, Trash and You. Big rows with details under each name. Actions open in a bottom sheet,
  and you long-press to select several files.
- **Android app:** no more black title bar. Auto-upload, updates and the drive address moved into
  *You → This phone*, and *Take a photo* opens the camera.
- Clearer messages when an Android update is blocked (for example by Google Play Protect), and stalled
  update downloads retry.

## 0.5.1

The first release that updates itself. (0.5.0 was never published: its Mac build only made the Apple silicon `.dmg`.)

- **Updates itself.** The desktop app checks GitHub for new versions, downloads them in the background, checks
  them against the release's `SHA256SUMS.txt`, and installs them. A drive hosted on the computer updates and
  restarts on its own (it's offline for under a minute); otherwise the tray offers *Restart to update*. Turn it
  off with *Update automatically* in the tray.
- **The Android app updates itself too.** It offers new versions when you open it, checks them, and hands them
  to Android to install. Android asks once for permission to install updates, then for a quick confirmation
  each time. ⋮ → *Check for updates* checks now.
- Releases are one command (`npm run release -- x.y.z`) and include the Windows installer, Mac `.dmg` files
  (Apple silicon and Intel) and the Android app.

## 0.4.0

- **RDocs**, a built-in document editor, and **Word / Excel / OpenDocument** import and export for documents
  and spreadsheets.

## 0.3.0

- Desktop app (Windows, macOS), Android app, server-to-server sync, RDrive Sheets, share links, trash, search,
  folder zip, WebDAV and MCP for AI agents.
