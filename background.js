/* Service worker: the part that can call chrome.* APIs.

   It owns the recorder's lifecycle, mints or picks the capture source,
   mirrors the recording state into session storage so the popup can render
   instantly, and opens the review tab when a take finishes. */

const OFFSCREEN_PATH = 'offscreen.html';
const RECORDER_TAB_PATH = 'recorder.html';
const STATE_KEY = 'recState';
const IDLE = { status: 'idle' };

const DEFAULT_OPTS = {
  mode: 'screen-camera',
  source: 'pick',
  micId: 'default',
  camId: 'default',
  sysAudio: true,
};

/* ---------- state ---------- */

async function getState() {
  const { [STATE_KEY]: s } = await chrome.storage.session.get(STATE_KEY);
  return s || IDLE;
}

async function setState(next) {
  await chrome.storage.session.set({ [STATE_KEY]: next });
  const rec = next.status === 'recording';
  chrome.action.setBadgeText({ text: next.status === 'idle' ? '' : rec ? 'REC' : 'II' });
  chrome.action.setBadgeBackgroundColor({ color: rec ? '#D93B3F' : '#5B6B7A' });
  chrome.runtime.sendMessage({ target: 'popup', t: 'state', state: next }).catch(() => {});
}

async function setError(message) {
  await chrome.storage.session.set({ lastError: message || '' });
  chrome.runtime.sendMessage({ target: 'popup', t: 'error', message }).catch(() => {});
}

/* ---------- recorder hosts ----------
   recorder.js runs in one of two documents, never both at once:

   - The offscreen document, for "This tab" and camera-only takes. A
     chrome.tabCapture stream ID minted without a consumerTabId is usable by
     any page of this extension, so the invisible document can take it.

   - A pinned recorder tab, for screens and windows. Those go through
     chrome.desktopCapture, whose stream ID is only accepted by the top-level
     frame of the targetTab it was minted for; any other document, offscreen
     included, gets a bare "AbortError: Error starting tab capture". So the
     tab that anchors the picker has to be the one that records. */

let creating = null;

async function findHosts() {
  return chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT', 'TAB'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH), chrome.runtime.getURL(RECORDER_TAB_PATH)],
  });
}

async function ensureOffscreen() {
  const hosts = await findHosts();
  if (hosts.some((c) => c.contextType === 'OFFSCREEN_DOCUMENT')) return;
  if (creating) { await creating; return; }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'BLOBS'],
    justification: 'Keeps a tab or camera recording running while the popup is closed.',
  });
  try { await creating; } finally { creating = null; }
}

async function closeOffscreen() {
  const hosts = await findHosts();
  if (hosts.some((c) => c.contextType === 'OFFSCREEN_DOCUMENT')) {
    try { await chrome.offscreen.closeDocument(); } catch {}
  }
}

async function closeRecorderTab() {
  const hosts = await findHosts();
  await Promise.all(hosts
    .filter((c) => c.contextType === 'TAB')
    .map((c) => chrome.tabs.remove(c.tabId).catch(() => {})));
}

async function closeHosts() {
  await closeRecorderTab();
  await closeOffscreen();
}

/* Opens the pinned recorder tab in front, and resolves once it has loaded:
   its URL has to be on chrome-extension:// by the time chooseDesktopMedia
   reads the tab's origin, and its listener has to exist before 'start'. It
   is active so the picker, which is attached to it, shows straight away. */
async function openRecorderTab(windowId) {
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(RECORDER_TAB_PATH),
    pinned: true,
    active: true,
    ...(windowId ? { windowId } : {}),
  });
  if (tab.status !== 'complete') {
    await new Promise((resolve) => {
      const onUpdated = (tabId, info) => {
        if (tabId !== tab.id || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }
  return chrome.tabs.get(tab.id);
}

function toRecorder(msg) {
  return chrome.runtime.sendMessage({ target: 'recorder', ...msg });
}

/* ---------- capture source ---------- */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

/* "This tab" from the keyboard shortcut. The popup mints its own ID; here the
   command itself counts as invoking the extension on the active tab. */
async function mintTabStreamId() {
  const tab = await activeTab();
  if (!tab) throw new Error('There is no tab to record.');
  return chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
}

async function pickSource(opts, recorderTab) {
  /* Screens and windows go through desktopCapture with the recorder tab as
     targetTab: from a service worker the call is refused without one. */
  const kinds = ['screen', 'window', 'tab'];
  const sources = opts.sysAudio ? [...kinds, 'audio'] : kinds;

  const picked = await new Promise((resolve, reject) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(sources, recorderTab, (id, options) => {
        const err = chrome.runtime.lastError;
        if (err) { reject(new Error(err.message)); return; }
        resolve({ id, options });
      });
    } catch (err) { reject(err); }
  });

  if (!picked.id) return null; // the picker was dismissed
  return {
    kind: 'desktop',
    streamId: picked.id,
    audio: !!(opts.sysAudio && picked.options?.canRequestAudioTrack),
  };
}

/* ---------- commands ---------- */

async function failStart(message) {
  await closeHosts();
  await setError(message);
  return { ok: false, error: message };
}

async function startRecording(rawOpts, tabStreamId) {
  const opts = { ...DEFAULT_OPTS, ...(rawOpts || {}) };
  const state = await getState();
  if (state.status !== 'idle') return { ok: false, error: 'A recording is already running.' };

  await setError('');
  await chrome.storage.local.set({ lastOpts: opts });

  const usesPicker = opts.mode !== 'camera' && opts.source !== 'tab';
  let source = null;
  let returnTo = null;

  if (usesPicker) {
    await closeHosts();
    returnTo = await activeTab();
    const recorderTab = await openRecorderTab(returnTo?.windowId);
    try {
      source = await pickSource(opts, recorderTab);
    } catch (err) {
      return failStart(err.message);
    }
    if (!source) {
      await closeHosts();
      if (returnTo) chrome.tabs.update(returnTo.id, { active: true }).catch(() => {});
      return { ok: false, cancelled: true };
    }
  } else {
    // The offscreen document comes first. A tab-capture stream ID is only
    // valid for a moment, and booting this document can take long enough to
    // expire one; the popup warms it up on open for the same reason.
    await closeRecorderTab();
    await ensureOffscreen();
    if (opts.mode !== 'camera') {
      try {
        const streamId = tabStreamId || await mintTabStreamId();
        source = { kind: 'tab', streamId, audio: opts.sysAudio };
      } catch (err) {
        return failStart(`This tab can't be recorded: ${err.message}`);
      }
    }
  }

  console.log('[Loopless] starting', { mode: opts.mode, source: source && { kind: source.kind, audio: source.audio, hasId: !!source.streamId } });
  let res;
  try {
    res = await toRecorder({ t: 'start', opts, source });
  } catch (err) {
    res = { ok: false, error: `The recorder didn't start: ${err.message}` };
  }
  // Back to whatever was in front before the recorder tab took over.
  if (returnTo) chrome.tabs.update(returnTo.id, { active: true }).catch(() => {});

  if (!res?.ok) {
    console.error('[Loopless] recorder refused to start:', res?.error);
    const out = await failStart(res?.error || 'The recorder refused to start.');
    return { ...out, needsGrant: res?.needsGrant };
  }

  await setState({ status: 'recording', startedAt: res.startedAt, elapsed: 0, mode: opts.mode });
  return { ok: true };
}

async function stopRecording() {
  const state = await getState();
  if (state.status === 'idle') return { ok: false, error: 'Nothing is recording.' };
  await setState({ ...state, status: 'stopping' });
  try {
    return await toRecorder({ t: 'stop' });
  } catch (err) {
    await setState(IDLE);
    await closeHosts();
    return { ok: false, error: err.message };
  }
}

async function togglePause() {
  const state = await getState();
  if (state.status !== 'recording' && state.status !== 'paused') return { ok: false };
  const res = await toRecorder({ t: 'pause' });
  if (res?.ok) {
    await setState({
      ...state,
      status: res.status,
      startedAt: res.startedAt || 0,
      elapsed: res.elapsed || 0,
    });
  }
  return res;
}

async function onFinished(msg) {
  await setState(IDLE);
  await closeHosts();
  if (msg.error) { await setError(msg.error); return; }
  await chrome.tabs.create({ url: chrome.runtime.getURL(`review.html?id=${encodeURIComponent(msg.id)}`) });
}

/* ---------- wiring ---------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'sw') return;
  (async () => {
    switch (msg.t) {
      case 'getState': sendResponse({ state: await getState() }); break;
      case 'start': sendResponse(await startRecording(msg.opts, msg.tabStreamId)); break;
      case 'prepare': await ensureOffscreen(); sendResponse({ ok: true }); break;
      case 'stop': sendResponse(await stopRecording()); break;
      case 'pause': sendResponse(await togglePause()); break;
      case 'finished': await onFinished(msg); sendResponse({ ok: true }); break;
      case 'warn': await setError(msg.message); sendResponse({ ok: true }); break;
      default: sendResponse({ ok: false, error: 'Unknown command.' });
    }
  })();
  return true;
});

// Closing the recorder tab by hand ends the take without saving it.
chrome.tabs.onRemoved.addListener(async () => {
  const state = await getState();
  if (state.status === 'idle' || (await findHosts()).length) return;
  await setState(IDLE);
  await setError('The Loopless recorder tab was closed, so that take was lost. Use Stop to keep a recording.');
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  const state = await getState();
  if (state.status === 'idle') {
    const { lastOpts } = await chrome.storage.local.get('lastOpts');
    await startRecording(lastOpts || DEFAULT_OPTS);
  } else {
    await stopRecording();
  }
});

// A fresh service worker means any previous recording is already gone.
chrome.runtime.onStartup.addListener(() => setState(IDLE));
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setState(IDLE);
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
  }
});
