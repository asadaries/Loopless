/* Google Drive, reached with the token Chrome holds for the signed-in profile.
   No GSI script, no popups, no client-side OAuth dance: chrome.identity does it,
   and the scope is declared in the manifest. Only drive.file is requested, so
   this extension can only ever see files it created itself. */
(function (global) {
  const FOLDER_NAME = 'Loopless recordings';
  const LEGACY_FOLDER_NAME = 'Takes recordings';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  let folderId = null;

  const CONNECTED_KEY = 'driveConnected';

  function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
      if (!chrome.identity?.getAuthToken) {
        reject(Object.assign(
          new Error('This browser has no chrome.identity.getAuthToken. Drive saving needs Google Chrome.'),
          { code: 'unsupported' },
        ));
        return;
      }
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const err = chrome.runtime.lastError;
        if (err || !token) {
          const msg = err?.message || 'No token';
          if (/OAuth2 not granted or revoked|not granted/i.test(msg)) {
            reject(Object.assign(new Error('Not connected to Google Drive.'), { code: 'needs_auth' }));
          } else if (/bad client id|invalid client/i.test(msg)) {
            reject(Object.assign(new Error('The OAuth client ID in manifest.json is missing or does not match this extension ID.'), { code: 'bad_client' }));
          } else if (/user is not signed in|not signed in/i.test(msg)) {
            reject(Object.assign(new Error('Sign in to Chrome with the Google account you want to save to.'), { code: 'no_profile' }));
          } else {
            reject(Object.assign(new Error(msg), { code: 'auth_failed' }));
          }
          return;
        }
        resolve(token);
      });
    });
  }

  function dropToken(token) {
    return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
  }

  /* Chrome keeps the grant for the whole profile, so "connected" is also a local
     choice: the flag below is what Connect and Disconnect actually toggle. To
     withdraw the grant itself, use Google Account → Data & privacy → Third-party
     apps, as the README notes. */
  async function connected() {
    const { [CONNECTED_KEY]: flag } = await chrome.storage.local.get(CONNECTED_KEY);
    if (!flag) return false;
    try { await getAuthToken(false); return true; } catch { return false; }
  }

  async function connect() {
    await getAuthToken(true);
    await chrome.storage.local.set({ [CONNECTED_KEY]: true });
  }

  async function disconnect() {
    try {
      const token = await getAuthToken(false);
      await dropToken(token);
    } catch {}
    await chrome.storage.local.set({ [CONNECTED_KEY]: false });
    folderId = null;
  }

  /** Drive REST call that refreshes a stale cached token once. */
  async function api(path, opts = {}, interactive = true, retried = false) {
    const token = await getAuthToken(interactive);
    const res = await fetch(`${API}/${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (res.status === 401 && !retried) {
      await dropToken(token);
      return api(path, opts, interactive, true);
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error?.message || msg; } catch {}
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  async function findFolder(folderName) {
    const name = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await api(`files?q=${q}&fields=files(id)&pageSize=1`);
    return found.files?.[0]?.id || null;
  }

  async function getFolderId() {
    if (folderId) return folderId;
    folderId = await findFolder(FOLDER_NAME);
    if (folderId) return folderId;

    // Before the rename the folder was "Takes recordings". Carry it over
    // rather than leave earlier uploads stranded in a second folder.
    const legacy = await findFolder(LEGACY_FOLDER_NAME);
    if (legacy) {
      await api(`files/${legacy}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME }),
      });
      folderId = legacy;
    } else {
      const made = await api('files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      });
      folderId = made.id;
    }
    return folderId;
  }

  function sendWithProgress(method, url, body, headers, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      Object.entries(headers).forEach(([k, v]) => x.setRequestHeader(k, v));
      x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.onload = () => (x.status >= 200 && x.status < 300
        ? resolve(JSON.parse(x.responseText || '{}'))
        : reject(new Error(`Upload failed (${x.status})`)));
      x.onerror = () => reject(new Error('Network error during upload.'));
      x.send(body);
    });
  }

  /** Resumable upload: one session, one PUT, real progress for big files. */
  async function upload(blob, name, onProgress) {
    const token = await getAuthToken(true);
    await chrome.storage.local.set({ [CONNECTED_KEY]: true });
    const parent = await getFolderId();
    const meta = { name, parents: [parent], mimeType: blob.type };
    const fields = 'fields=id,name,webViewLink';

    const init = await fetch(`${UPLOAD}/files?uploadType=resumable&${fields}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': blob.type,
      },
      body: JSON.stringify(meta),
    });
    if (!init.ok) {
      let msg = `HTTP ${init.status}`;
      try { msg = (await init.json()).error?.message || msg; } catch {}
      throw new Error(msg);
    }
    const session = init.headers.get('Location');
    if (session) return sendWithProgress('PUT', session, blob, { 'Content-Type': blob.type }, onProgress);

    // Fallback if the session URL is withheld: single multipart request.
    const boundary = `takes${Math.random().toString(36).slice(2)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${blob.type}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    return sendWithProgress('POST', `${UPLOAD}/files?uploadType=multipart&${fields}`, body, {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    }, onProgress);
  }

  function shareWithAnyone(fileId) {
    return api(`files/${fileId}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
  }

  async function folderLink() {
    const id = await getFolderId();
    return `https://drive.google.com/drive/folders/${id}`;
  }

  global.Drive = { FOLDER_NAME, connected, connect, disconnect, upload, shareWithAnyone, folderLink, api };
})(self);
