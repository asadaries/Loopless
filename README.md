# Loopless — Chrome extension

Records your screen, your camera, or both, then saves to a `Loopless recordings`
folder in your Google Drive. Recording keeps running when the popup closes.

## Install

1. Open `chrome://extensions`, turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. A setup tab opens. Click **Grant access** to allow the camera and microphone
   once. After that, starting a recording never stops to ask.

That's enough to record and download. Drive saving needs one more step.

## Connecting Google Drive

Drive uses `chrome.identity`, which ties the OAuth client to this extension's ID.
So the ID has to exist before you create the client.

1. On `chrome://extensions`, copy the **ID** under Loopless (a 32-letter string).
   For an unpacked extension this ID is derived from the folder path, so it stays
   the same as long as you don't move the folder.
2. At [console.cloud.google.com](https://console.cloud.google.com) create a
   project, then **APIs & Services → Library → Google Drive API → Enable**.
3. **OAuth consent screen**: choose External, fill in a name and your email, and
   add your own Gmail address under **Audience → Test users**. Leaving it in
   Testing mode is fine for personal use.
4. **Credentials → Create credentials → OAuth client ID → Chrome Extension**.
   Paste the extension ID from step 1. Copy the client ID it gives you.
5. Open `manifest.json` and replace
   `PASTE_YOUR_CHROME_EXTENSION_CLIENT_ID.apps.googleusercontent.com`
   with that client ID.
6. Back on `chrome://extensions`, click **Reload** on Loopless, then **Connect
   Google Drive** in the popup.

You must be signed into Chrome with that same Google account.

The scope is `drive.file`, the narrowest one Drive offers: the extension can only
ever see files it created itself, never the rest of your Drive. **Disconnect**
forgets the connection locally; to withdraw the grant itself, go to Google
Account → Data & privacy → Third-party apps.

## Using it

- **Alt+Shift+R** starts and stops without opening the popup. Rebind it at
  `chrome://extensions/shortcuts`.
- In **Screen + camera**, the camera is drawn into the video as a circle at the
  bottom-left, so it's recorded whatever you share — a tab, a window, or the
  whole screen.
- **Record: This tab** skips Chrome's picker and grabs the current tab directly,
  with its audio. Tab audio stays audible to you while it records.
- Screen and window takes add a pinned **Loopless · Recording** tab, which does the
  recording. Leave it open, because closing it discards the take. Use Stop
  instead. "This tab" and camera-only takes open nothing.
- When a take finishes, a review tab opens: play it back, rename it, save it to
  Drive, or download it.
- **All takes** in the popup opens the library: every recording, which ones are
  in Drive, and an Upload button (or **Upload all**) for those that aren't.
  **Upload** next to a recent take in the popup does the same for that one.
- Recordings are kept in the extension's own IndexedDB until you delete them, so
  a failed upload never loses one. Deleting a take here leaves the Drive copy
  alone.

## How it's put together

| File | Does |
| --- | --- |
| `manifest.json` | Permissions, OAuth client, keyboard shortcut |
| `background.js` | Service worker: picks and owns the recorder's host, gets the capture source, mirrors state for the popup |
| `recorder.js` | The recorder. Capture, camera compositing, audio mixing, `MediaRecorder`. Runs in `offscreen.html` or the pinned `recorder.html` tab |
| `popup.js` | Controls. Holds no state — it's destroyed whenever it loses focus |
| `review.js` | Playback, rename, Drive upload, download, delete |
| `library.js` | Every take with its Drive status: upload one or all, download, delete |
| `permissions.js` | One-time camera and mic grant, Drive connection |
| `lib/db.js` | IndexedDB shared by every page on the extension origin |
| `lib/drive.js` | Drive REST calls and token handling |

A popup is torn down the moment it loses focus, so the recording runs somewhere
else. Tab and camera takes use an invisible offscreen document. Screens and
windows can't: called from a service worker, Chrome's screen picker must be
given a tab, and the stream it returns works only in that tab's page. So for
those, a pinned recorder tab is both the page the picker is opened for and the
page that records.
The finished blob reaches the review tab through IndexedDB, since blob URLs
don't cross documents but a shared origin database does.

## Limits

- Chrome won't record `chrome://` pages, the Web Store, or other extensions'
  pages. Share a screen or window for those.
- System audio capture works on Windows and ChromeOS. On macOS, Chrome only
  offers tab audio.
- Recent Chrome records MP4; older builds fall back to WebM. Both play in Drive.
- `chrome.identity.getAuthToken` is Chrome-only. On Chromium forks the recorder
  works and Drive saving doesn't.
- This is unpacked, so it isn't in the Web Store and gets no auto-updates. It
  survives restarts as long as Developer mode stays on.

## License

MIT. See [LICENSE](LICENSE).
