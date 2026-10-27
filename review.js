/* Review tab: play the take back, name it, push it to Drive, download it, bin it.
   The blob comes out of the shared IndexedDB store the recorder window wrote
   it to, so this page can make its own object URL for it. */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let record = null;
let blobUrl = null;

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const fmtSize = (bytes) => {
  const mb = Number(bytes || 0) / 1048576;
  return mb < 1 ? `${Math.max(1, Math.round(Number(bytes) / 1024))} KB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
};
function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}
function fileName() {
  const base = ($('title').value.trim() || 'Recording').replace(/[\\/:*?"<>|]+/g, '-');
  return `${base}.${record.ext}`;
}

async function load(id) {
  record = id ? await LooplessDB.get(id) : (await LooplessDB.list({ limit: 1 }))[0];
  if (!record) {
    $('stageMsg').textContent = 'That recording is no longer here.';
    renderList();
    return;
  }
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(record.blob);

  $('player').src = blobUrl;
  $('player').hidden = false;
  $('stageMsg').hidden = true;
  $('panel').hidden = false;
  $('title').value = record.title;
  $('meta').textContent = [
    new Date(record.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    fmtTime(record.durationMs),
    fmtSize(record.bytes),
    record.ext.toUpperCase(),
  ].join(' · ');

  $('result').hidden = true;
  showError('');
  if (record.drive) showSaved(record.drive.link);
  else {
    $('saveBtn').disabled = false;
    $('saveBtn').textContent = 'Save to Drive';
    $('share').checked = false;
    $('share').disabled = false;
  }
  renderList();
}

function showSaved(link) {
  $('saveBtn').disabled = true;
  $('saveBtn').textContent = 'Saved';
  $('share').disabled = true;
  $('progress').hidden = true;
  const r = $('result');
  r.innerHTML = '';
  r.append(
    'In Drive.',
    Object.assign(document.createElement('a'), { href: link, target: '_blank', rel: 'noopener', textContent: 'Open' }),
    Object.assign(document.createElement('button'), {
      className: 'link', textContent: 'Copy link',
      onclick: async () => {
        try { await navigator.clipboard.writeText(link); } catch { prompt('Copy this link:', link); }
      },
    }),
  );
  r.hidden = false;
}

$('title').onchange = async () => {
  if (!record) return;
  record = await LooplessDB.patch(record.id, { title: $('title').value.trim() || record.title });
  renderList();
};

$('saveBtn').onclick = async () => {
  if (!record) return;
  $('saveBtn').disabled = true;
  $('saveBtn').textContent = 'Saving…';
  showError('');
  $('progress').hidden = false;
  $('progressBar').style.width = '0%';
  try {
    const file = await Drive.upload(record.blob, fileName(), (p) => {
      $('progressBar').style.width = `${Math.round(p * 100)}%`;
    });
    $('progressBar').style.width = '100%';
    if ($('share').checked) await Drive.shareWithAnyone(file.id);
    const link = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
    record = await LooplessDB.patch(record.id, { drive: { fileId: file.id, link } });
    showSaved(link);
  } catch (err) {
    $('saveBtn').disabled = false;
    $('saveBtn').textContent = 'Save to Drive';
    $('progress').hidden = true;
    showError(`Couldn’t save to Drive. ${err.message} The recording is still here, and you can download it.`);
  }
};

$('downloadBtn').onclick = () => {
  if (!record) return;
  chrome.downloads.download({ url: blobUrl, filename: fileName(), saveAs: true }, () => {
    const err = chrome.runtime.lastError;
    if (err && !/user canceled|canceled/i.test(err.message)) showError(err.message);
  });
};

$('deleteBtn').onclick = async () => {
  if (!record) return;
  const inDrive = record.drive ? ' The copy in Drive is kept.' : '';
  if (!confirm(`Delete “${record.title}” from this computer?${inDrive}`)) return;
  await LooplessDB.delete(record.id);
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  record = null;
  $('player').hidden = true;
  $('player').removeAttribute('src');
  $('panel').hidden = true;
  $('meta').textContent = '';
  $('stageMsg').textContent = 'Deleted.';
  $('stageMsg').hidden = false;
  renderList();
};

async function renderList() {
  const rows = await LooplessDB.list({ limit: 50, meta: true });
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
        textContent: [
          new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
          fmtTime(r.durationMs),
          fmtSize(r.bytes),
        ].join(' · '),
      }),
    );
    const open = Object.assign(document.createElement('button'), {
      className: 'link',
      textContent: record && r.id === record.id ? 'Showing' : 'Open',
      disabled: !!(record && r.id === record.id),
    });
    open.onclick = () => {
      history.replaceState(null, '', `review.html?id=${encodeURIComponent(r.id)}`);
      load(r.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    li.append(dot, grow, open);
    ul.append(li);
  });
}

load(params.get('id'));
