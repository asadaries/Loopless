/* Library tab: every take on this computer, with its Drive status. Upload the
   ones that aren't in Drive yet, one at a time or all together, download or
   delete any of them, or open one in the review tab to watch it.

   Uploads run here rather than in the popup, which is destroyed the moment it
   loses focus. ?upload=<id> starts that take's upload on load: it is how the
   popup hands an upload over. */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let rows = [];
const uploading = new Map(); // id → progress 0..1
const rowErrors = new Map(); // id → message
let uploadingAll = false;

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const fmtSize = (bytes) => {
  const mb = Number(bytes || 0) / 1048576;
  return mb < 1 ? `${Math.max(1, Math.round(Number(bytes) / 1024))} KB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
};
const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}
function fileName(r) {
  const base = (r.title.trim() || 'Recording').replace(/[\\/:*?"<>|]+/g, '-');
  return `${base}.${r.ext}`;
}
const pending = () => rows.filter((r) => !r.drive);

/* ---------- actions ---------- */

async function upload(id) {
  if (uploading.has(id)) return;
  const record = await LooplessDB.get(id);
  if (!record || record.drive) { await refresh(); return; }

  uploading.set(id, 0);
  rowErrors.delete(id);
  render();
  try {
    const file = await Drive.upload(record.blob, fileName(record), (p) => {
      uploading.set(id, p);
      const bar = document.querySelector(`[data-progress="${CSS.escape(id)}"]`);
      if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    });
    if ($('share').checked) await Drive.shareWithAnyone(file.id);
    const link = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
    await LooplessDB.patch(id, { drive: { fileId: file.id, link } });
  } catch (err) {
    rowErrors.set(id, `Couldn’t save to Drive. ${err.message}`);
  }
  uploading.delete(id);
  await refresh();
  refreshDrive();
}

async function uploadAll() {
  uploadingAll = true;
  showError('');
  render();
  // One at a time: each take can be hundreds of megabytes.
  for (const r of pending()) {
    await upload(r.id);
    if (rowErrors.has(r.id)) break; // most failures (auth, network) would repeat for the rest
  }
  uploadingAll = false;
  render();
}

async function download(id) {
  const record = await LooplessDB.get(id);
  if (!record) return;
  const url = URL.createObjectURL(record.blob);
  chrome.downloads.download({ url, filename: fileName(record), saveAs: true }, () => {
    const err = chrome.runtime.lastError;
    if (err && !/user canceled|canceled/i.test(err.message)) showError(err.message);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}

async function remove(r) {
  const inDrive = r.drive ? ' The copy in Drive is kept.' : '';
  if (!confirm(`Delete “${r.title}” from this computer?${inDrive}`)) return;
  await LooplessDB.delete(r.id);
  await refresh();
}

/* ---------- rendering ---------- */

function button(text, className, onclick, disabled = false) {
  return Object.assign(document.createElement('button'), { className, textContent: text, onclick, disabled });
}

function renderRow(r) {
  const li = document.createElement('li');
  const busy = uploading.has(r.id);

  const dot = Object.assign(document.createElement('span'), { className: `dot ${r.drive ? 'saved' : 'local'}` });
  dot.title = r.drive ? 'Saved to Drive' : 'On this computer only';

  const grow = Object.assign(document.createElement('div'), { className: 'grow' });
  const status = Object.assign(document.createElement('div'), { className: 'status' });
  if (r.drive) {
    status.append('In Drive · ', Object.assign(document.createElement('a'), {
      href: r.drive.link, target: '_blank', rel: 'noopener', textContent: 'Open in Drive',
    }));
  } else {
    status.textContent = busy ? 'Uploading…' : 'Not uploaded';
  }
  grow.append(
    Object.assign(document.createElement('div'), { className: 'name', textContent: r.title }),
    Object.assign(document.createElement('div'), {
      className: 'meta',
      textContent: [fmtDate(r.createdAt), fmtTime(r.durationMs), fmtSize(r.bytes), r.ext.toUpperCase()].join(' · '),
    }),
    status,
  );

  const actions = Object.assign(document.createElement('div'), { className: 'row-actions' });
  if (!r.drive) {
    actions.append(button(busy ? 'Uploading…' : 'Upload', 'btn primary', () => upload(r.id), busy || uploadingAll));
  }
  actions.append(
    button('Watch', 'btn', () => chrome.tabs.create({ url: chrome.runtime.getURL(`review.html?id=${encodeURIComponent(r.id)}`) })),
    button('Download', 'btn', () => download(r.id)),
    button('Delete', 'btn danger-text', () => remove(r), busy),
  );

  li.append(dot, grow, actions);

  if (busy) {
    const bar = Object.assign(document.createElement('div'), { className: 'progress row-progress' });
    const fill = document.createElement('div');
    fill.dataset.progress = r.id;
    fill.style.width = `${Math.round(uploading.get(r.id) * 100)}%`;
    bar.append(fill);
    li.append(bar);
  }
  if (rowErrors.has(r.id)) {
    li.append(Object.assign(document.createElement('p'), { className: 'error row-error', textContent: rowErrors.get(r.id) }));
  }
  return li;
}

function render() {
  const ul = $('takes');
  ul.innerHTML = '';
  rows.forEach((r) => ul.append(renderRow(r)));
  $('takesEmpty').hidden = rows.length > 0;

  const left = pending().length;
  const total = rows.reduce((n, r) => n + (r.bytes || 0), 0);
  $('summary').textContent = rows.length
    ? `${rows.length} ${rows.length === 1 ? 'take' : 'takes'} · ${fmtSize(total)} · ${left ? `${left} not in Drive` : 'all in Drive'}`
    : '';
  $('uploadAllBtn').hidden = left < 2;
  $('uploadAllBtn').disabled = uploadingAll || uploading.size > 0;
  $('uploadAllBtn').textContent = uploadingAll ? 'Uploading…' : `Upload all (${left})`;
}

async function refresh() {
  rows = await LooplessDB.list({ limit: 1000, meta: true });
  render();
}

async function refreshDrive() {
  const on = await Drive.connected();
  $('driveLabel').textContent = on ? `Saving to “${Drive.FOLDER_NAME}”` : 'Google Drive not connected. Upload will ask you to connect.';
  $('driveFolder').hidden = !on;
  if (on) {
    try { $('driveFolder').href = await Drive.folderLink(); } catch { $('driveFolder').hidden = true; }
  }
}

$('uploadAllBtn').onclick = uploadAll;

// Recordings made, renamed or deleted in another tab show up here on return.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !uploading.size) refresh(); });

(async () => {
  await refresh();
  refreshDrive();
  const id = params.get('upload');
  if (id) {
    history.replaceState(null, '', 'library.html');
    upload(id);
  }
})();
