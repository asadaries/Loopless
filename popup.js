/* Popup: controls only. It holds no recording state of its own, because it is
   destroyed every time it loses focus. On open it asks the service worker what
   is going on and renders that. */

const $ = (id) => document.getElementById(id);
const ask = (t, extra = {}) => chrome.runtime.sendMessage({ target: 'sw', t, ...extra });

let state = { status: 'idle' };
let ticker = null;

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const fmtSize = (bytes) => {
  const mb = Number(bytes || 0) / 1048576;
  return mb < 1 ? `${Math.max(1, Math.round(Number(bytes) / 1024))} KB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
};
const modeValue = () => document.querySelector('input[name=mode]:checked').value;

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

/* ---------- settings ---------- */

function updateModeUI() {
  const mode = modeValue();
  $('camField').hidden = mode === 'screen';
  $('sourceField').hidden = mode === 'camera';
  $('sysAudioField').hidden = mode === 'camera';
}

function currentOpts() {
  return {
    mode: modeValue(),
    source: $('sourceSelect').value,
    micId: $('micSelect').value,
    camId: $('camSelect').value,
    sysAudio: $('sysAudio').checked,
  };
}

function fillSelect(select, devices, fixed) {
  const prev = select.value;
  select.innerHTML = '';
  fixed.forEach(([v, t]) => select.add(new Option(t, v)));
  devices.forEach((d, i) => {
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') return;
    select.add(new Option(d.label || `Device ${i + 1}`, d.deviceId));
  });
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
}

async function loadDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    fillSelect($('micSelect'), list.filter((d) => d.kind === 'audioinput'), [['default', 'Default'], ['none', 'None']]);
    fillSelect($('camSelect'), list.filter((d) => d.kind === 'videoinput'), [['default', 'Default']]);
    // Labels stay blank until camera and mic access has been granted once.
    if (list.some((d) => (d.kind === 'audioinput' || d.kind === 'videoinput') && !d.label)) {
      showGrantHint();
    }
  } catch {}
}

function showGrantHint() {
  const e = $('error');
  e.innerHTML = '';
  e.append('Camera and microphone access hasn’t been granted yet. ');
  const a = Object.assign(document.createElement('button'), { className: 'link', textContent: 'Grant it once' });
  a.onclick = () => chrome.runtime.openOptionsPage();
  e.append(a);
  e.hidden = false;
}

async function restoreOpts() {
  const { lastOpts } = await chrome.storage.local.get('lastOpts');
  if (!lastOpts) return;
  const radio = document.querySelector(`input[name=mode][value="${lastOpts.mode}"]`);
  if (radio) radio.checked = true;
  if (lastOpts.source) $('sourceSelect').value = lastOpts.source;
  $('sysAudio').checked = lastOpts.sysAudio !== false;
  ['micSelect', 'camSelect'].forEach((id) => {
    const key = id === 'micSelect' ? 'micId' : 'camId';
    const sel = $(id);
    if (lastOpts[key] && [...sel.options].some((o) => o.value === lastOpts[key])) sel.value = lastOpts[key];
  });
  updateModeUI();
}

/* ---------- recording state ---------- */

function elapsedOf(s) {
  return (s.elapsed || 0) + (s.startedAt ? Date.now() - s.startedAt : 0);
}

function render() {
  const live = state.status === 'recording' || state.status === 'paused';
  const recording = state.status === 'recording';

  $('recBtn').classList.toggle('stop', live || state.status === 'stopping');
  $('recBtn').setAttribute('aria-label', live ? 'Stop recording' : 'Start recording');
  $('recBtn').disabled = state.status === 'stopping';
  $('pauseBtn').hidden = !live;
  $('pauseBtn').textContent = recording ? 'Pause' : 'Resume';
  $('settings').hidden = live || state.status === 'stopping';

  const label = $('recState');
  label.innerHTML = '';
  if (recording) label.append(Object.assign(document.createElement('span'), { className: 'pulse' }));
  label.append(document.createTextNode(
    recording ? 'Recording' : state.status === 'paused' ? 'Paused'
      : state.status === 'stopping' ? 'Finishing up…' : 'Not recording',
  ));

  $('timer').textContent = fmtTime(live || state.status === 'stopping' ? elapsedOf(state) : 0);

  clearInterval(ticker);
  if (recording) ticker = setInterval(() => ($('timer').textContent = fmtTime(elapsedOf(state))), 250);
}

async function refreshState() {
  const res = await ask('getState');
  state = res?.state || { status: 'idle' };
  render();
}

$('recBtn').onclick = async () => {
  if (state.status === 'recording' || state.status === 'paused') {
    await ask('stop');
    await refreshState();
    return;
  }
  $('recBtn').disabled = true;
  showError('');

  // "This tab" needs no picker: the popup is open on that tab, which counts as
  // invoking the extension there, so it can mint the capture ID itself. No
  // consumerTabId, so the offscreen recorder is allowed to use it.
  const opts = currentOpts();
  let tabStreamId;
  if (opts.mode !== 'camera' && opts.source === 'tab') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabStreamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (err) {
      $('recBtn').disabled = false;
      showError(`This tab can't be recorded: ${err.message}`);
      return;
    }
  }

  const res = await ask('start', { opts, tabStreamId });
  $('recBtn').disabled = false;
  if (res?.ok) {
    await refreshState();
  } else if (!res?.cancelled) {
    if (res?.needsGrant) showGrantHint();
    else showError(res?.error || 'The recording didn’t start.');
  }
};

$('pauseBtn').onclick = async () => { await ask('pause'); await refreshState(); };

$('libraryBtn').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });

$('shortcutBtn').onclick =() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', updateModeUI));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'popup') return;
  if (msg.t === 'state') { state = msg.state; render(); }
  if (msg.t === 'error') showError(msg.message);
});

/* ---------- recent takes ---------- */

async function loadTakes() {
  const rows = await LooplessDB.list({ limit: 4, meta: true });
  const ul = $('takes');
  ul.innerHTML = '';
  $('takesEmpty').hidden = rows.length > 0;
  rows.forEach((r) => {
    const li = document.createElement('li');
    const dot = Object.assign(document.createElement('span'), { className: `dot ${r.drive ? 'saved' : 'local'}` });
    dot.title = r.drive ? 'Saved to Drive' : 'On this computer only';
    const grow = Object.assign(document.createElement('div'), { className: 'grow' });
    grow.append(
      Object.assign(document.createElement('div'), { className: 'name', textContent: r.title }),
      Object.assign(document.createElement('div'), {
        className: 'meta',
        textContent: [fmtTime(r.durationMs), fmtSize(r.bytes)].join(' · '),
      }),
    );
    const open = Object.assign(document.createElement('button'), { className: 'link', textContent: 'Open' });
    open.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL(`review.html?id=${encodeURIComponent(r.id)}`) });
    li.append(dot, grow);
    if (!r.drive) {
      // The upload runs in the library tab: this popup dies as soon as it loses focus.
      const up = Object.assign(document.createElement('button'), { className: 'link', textContent: 'Upload' });
      up.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL(`library.html?upload=${encodeURIComponent(r.id)}`) });
      li.append(up);
    }
    li.append(open);
    ul.append(li);
  });
}

/* ---------- drive ---------- */

async function refreshDrive() {
  const on = await Drive.connected();
  $('driveLabel').textContent = on ? `Saving to “${Drive.FOLDER_NAME}”` : 'Google Drive not connected';
  $('driveBtn').textContent = on ? 'Disconnect' : 'Connect';
  $('driveFolder').hidden = !on;
  if (on) {
    try { $('driveFolder').href = await Drive.folderLink(); } catch { $('driveFolder').hidden = true; }
  }
}

$('driveBtn').onclick = async () => {
  $('driveBtn').disabled = true;
  try {
    if (await Drive.connected()) await Drive.disconnect();
    else await Drive.connect();
    showError('');
  } catch (err) {
    showError(err.message);
  }
  $('driveBtn').disabled = false;
  refreshDrive();
};

/* ---------- boot ---------- */

(async () => {
  updateModeUI();
  await loadDevices();
  await restoreOpts();
  await refreshState();
  if (state.status === 'idle') ask('prepare').catch(() => {});
  loadTakes();
  refreshDrive();
  const { lastError } = await chrome.storage.session.get('lastError');
  if (lastError) showError(lastError);
})();
