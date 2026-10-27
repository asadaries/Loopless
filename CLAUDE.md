# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Loopless: a Manifest V3 Chrome extension (Chrome 116+) that records screen, camera, or both and uploads to a `Loopless recordings` folder in Google Drive. Plain JavaScript loaded straight by Chrome: no build step, no package manager, no bundler, no tests, no linter.

## Running it

- Load unpacked at `chrome://extensions` (Developer mode on), pick this folder. After editing files, click **Reload** on the extension card. Popup/review/permissions pages pick up changes on reopen; the service worker and offscreen document need the reload.
- Debug each context separately: service worker via "Inspect views: service worker" on the extension card; the offscreen document under "Inspect views" while it exists; the pinned recorder tab (only during screen/window takes) and popup via right-click → Inspect. Logs are prefixed `[Loopless]`.
- Drive needs `oauth2.client_id` in [manifest.json](manifest.json) to be a "Chrome Extension" OAuth client registered for this extension's ID. The unpacked ID comes from the folder path, so moving the folder breaks Drive auth. Setup steps are in [README.md](README.md).
- The repo is public and commits `manifest.json` with the `PASTE_YOUR_CHROME_EXTENSION_CLIENT_ID…` placeholder. The local copy holds the real client ID and is marked `git update-index --skip-worktree manifest.json`, so git ignores local changes to it. To commit a manifest change: run `git update-index --no-skip-worktree manifest.json`, put the placeholder back for the commit, then restore the real ID and re-mark the file.
- `takes-signing-key.pem.txt` (the file name predates the rename) is the extension's private signing key. Never print, commit, or change it.

## Architecture

Four contexts on one `chrome-extension://` origin, talking through `chrome.runtime.sendMessage`. Every message has a `target` (`'sw'`, `'recorder'`, `'popup'`) and a command `t`. Each listener ignores messages for other targets. When adding a command, add it to the receiver's `switch` and keep `return true` for the async `sendResponse`.

- **[background.js](background.js)** (service worker): picks which document hosts the recorder, opens and closes it, mints or picks the capture source, and keeps the recording state (`idle` / `recording` / `paused` / `stopping`) in `chrome.storage.session` under `recState`, plus the toolbar badge. It also handles the Alt+Shift+R command, which reuses `lastOpts` from `chrome.storage.local`.
- **[recorder.js](recorder.js)**: the recorder. It holds the `getUserMedia` streams, the camera-bubble compositor (`MediaStreamTrackProcessor`/`Generator`, with a canvas fallback that throttles in a background tab), audio mixing through `AudioContext`, and `MediaRecorder`. It runs in exactly one of two hosts, both listening on target `'recorder'`:
  - [offscreen.html](offscreen.html), invisible, for "This tab" and camera-only takes. The popup sends `prepare` on open to warm it up.
  - [recorder.html](recorder.html), a pinned tab, for screen and window takes. Closing it by hand discards the take, and the SW's `tabs.onRemoved` handler then resets the state.
- **[popup.js](popup.js)**: stateless controls, destroyed whenever it loses focus. On open it asks the SW for the current state and renders it.
- **[review.js](review.js)** opens after each take (`review.html?id=…`) for playback, rename, Drive upload, download and delete. **[library.js](library.js)** lists every take and uploads the ones not yet in Drive (one at a time, stopping at the first failure). The popup can't upload because it dies on blur, so its per-take Upload opens `library.html?upload=<id>`. A take counts as uploaded when its record has `drive` set. **[permissions.js](permissions.js)** is the options/setup page that requests camera and mic once.
- **[lib/db.js](lib/db.js)** (`self.LooplessDB`) and **[lib/drive.js](lib/drive.js)** (`self.Drive`) are IIFEs that set globals and load through `<script>` tags. They aren't ES modules. Pages include only what they use (the recorder loads `db.js` only).

### Constraints behind the design (easy to break)

- **Finished recordings reach other pages through IndexedDB.** Blob URLs don't cross documents. The recorder writes `{id, title, mime, ext, bytes, durationMs, createdAt, mode, drive, blob}` to the `takes`/`recordings` store, then sends `finished`, and the SW closes the recorder and opens the review tab. Recordings stay in IndexedDB until the user deletes them.
- **Camera/mic permission is granted once from permissions.html**, so starting a recording never stops at a prompt. The grant applies to the whole origin. A `NotAllowedError` in the recorder comes back as `needsGrant`, and the popup links to the options page.
- **Why two hosts:** they handle two different capture APIs.
  - "This tab" uses `chrome.tabCapture.getMediaStreamId` with no `consumerTabId`. Any page of the extension can use that ID, including the offscreen doc. The popup mints it in its click handler (opening the popup counts as invoking the extension on that tab), and the keyboard shortcut mints it in the SW.
  - Screens and windows use `chrome.desktopCapture.chooseDesktopMedia`. From a SW it requires a `targetTab` ("A target tab is required…"), and the ID works only in *that tab's top-level frame*. Anywhere else, offscreen included, it fails with `AbortError: Error starting tab capture`. So the pinned recorder tab is both the `targetTab` and the consumer. It is opened active so the picker shows, and the previously active tab is brought back once the take starts.
- **Stream IDs are single-use and expire fast.** The host must be loaded *before* the ID is minted or picked: `ensureOffscreen()` or `openRecorderTab()`, which waits for `status: 'complete'`. `getScreenStream` makes exactly one `getUserMedia` attempt with bare constraints. Don't add retries or extra constraints.
- **Drive** uses `chrome.identity.getAuthToken` with the `drive.file` scope (the extension sees only files it created). "Connected" is a local flag (`driveConnected` in `storage.local`) on top of Chrome's grant for the profile. Uploads are resumable with XHR progress, falling back to multipart. `api()` drops the cached token and retries once on 401.
- MIME choice prefers MP4 and falls back to WebM (`pickMime`). The record's `ext` follows from it.

## Style

Vanilla DOM (`$ = id => document.getElementById(id)`, `Object.assign(document.createElement(...), {...})`), async/await, and errors returned as `{ ok, error }` objects instead of thrown across message boundaries. Comments explain *why* a Chrome-platform constraint forces the design. Keep those comments when editing.
