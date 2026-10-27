/* The recorder itself, so a take survives the popup closing. It is loaded by
   offscreen.html for "This tab" and camera-only takes, and by the pinned
   recorder.html tab for screens and windows, whose desktopCapture stream ID
   only that tab's frame may use. The service worker picks the host.

   The service worker also mints or picks the capture source and hands it
   over by message. Everything media-related happens here. */

const rec = {
  recorder: null,
  chunks: [],
  streams: [],
  audioCtx: null,
  compositor: null,
  sourceTrack: null,
  mime: '',
  startedAt: 0,
  elapsed: 0,
  meta: null,
};

const elapsedNow = () => rec.elapsed + (rec.startedAt ? Date.now() - rec.startedAt : 0);
const tell = (msg) => chrome.runtime.sendMessage({ target: 'sw', ...msg }).catch(() => {});

/* ---------- capture ---------- */

async function getScreenStream(source) {
  const kind = source.kind === 'tab' ? 'tab' : 'desktop';
  const id = source.streamId;
  const base = { chromeMediaSource: kind, chromeMediaSourceId: id };

  /* ONE attempt only. A capture stream ID is single-use: the moment the first
     getUserMedia touches it, it is spent, and every retry fails with a generic
     "Error starting tab capture" that says nothing about what actually went
     wrong. So no fallbacks, no quality hints that might be refused — just the
     bare source constraints, and the real error if it fails. */
  const constraints = { video: { mandatory: { ...base } } };
  if (source.audio) constraints.audio = { mandatory: { ...base } };

  console.log('[Loopless] requesting capture', JSON.stringify(constraints));
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.error('[Loopless] capture failed', err.name, err.message, err);
    throw Object.assign(new Error(`${err.name}: ${err.message}`), { cause: err });
  }
}

function pickMime() {
  const options = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

/* ---------- compositor ----------
   Draws the camera into the screen video as a round bubble, bottom-left.
   In the extension there is no floating preview window to capture, so the
   camera is always composited in and is recorded whatever you share. */

function createCompositor(screenTrack, camTrack) {
  const comp = { track: null, stop: null };
  const MAX_W = 2560;
  const dims = (src) => [src.displayWidth || src.videoWidth || 0, src.displayHeight || src.videoHeight || 0];
  let canvas, ctx;

  function paint(screenSrc, camSrc) {
    const [sw, sh] = dims(screenSrc);
    if (!sw || !sh) return false;
    const scale = Math.min(1, MAX_W / sw);
    const W = Math.round((sw * scale) / 2) * 2;
    const H = Math.round((sh * scale) / 2) * 2;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.drawImage(screenSrc, 0, 0, W, H);
    if (camSrc) {
      const [cw, ch] = dims(camSrc);
      if (cw && ch) {
        const d = Math.round(Math.min(W, H) * 0.28);
        const m = Math.round(Math.min(W, H) * 0.03);
        const x = m, y = H - d - m, r = d / 2, side = Math.min(cw, ch);
        ctx.save();
        ctx.beginPath(); ctx.arc(x + r, y + r, r, 0, Math.PI * 2); ctx.clip();
        ctx.translate(x + d, y); ctx.scale(-1, 1); // mirror, the way you see yourself
        ctx.drawImage(camSrc, (cw - side) / 2, (ch - side) / 2, side, side, 0, 0, d, d);
        ctx.restore();
        ctx.beginPath(); ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(3, Math.round(d * 0.02));
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      }
    }
    return true;
  }

  if ('MediaStreamTrackProcessor' in self && 'MediaStreamTrackGenerator' in self) {
    // Frame-by-frame pipeline: unaffected by the document being hidden.
    canvas = new OffscreenCanvas(1280, 720);
    ctx = canvas.getContext('2d');
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = gen.writable.getWriter();
    const readers = [];
    let screenFrame = null, camFrame = null, lastCamAt = 0, writing = false, stopped = false;

    const emit = () => {
      if (writing || stopped || !screenFrame) return;
      if (!paint(screenFrame, camFrame)) return;
      writing = true;
      const out = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
      writer.write(out)
        .catch(() => { try { out.close(); } catch {} })
        .finally(() => { writing = false; });
    };
    const pump = async (track, onFrame) => {
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      readers.push(reader);
      try {
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          if (stopped) { value.close(); break; }
          onFrame(value);
        }
      } catch {}
    };
    // The camera sets a steady cadence; the screen only drives output if it goes quiet.
    pump(screenTrack, (f) => {
      screenFrame?.close(); screenFrame = f;
      if (performance.now() - lastCamAt > 150) emit();
    });
    pump(camTrack, (f) => {
      camFrame?.close(); camFrame = f; lastCamAt = performance.now();
      emit();
    });

    comp.track = gen;
    comp.stop = () => {
      stopped = true;
      readers.forEach((r) => r.cancel().catch(() => {}));
      screenFrame?.close(); camFrame?.close(); screenFrame = camFrame = null;
      writer.close().catch(() => {});
      gen.stop();
    };
  } else {
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    const sv = document.createElement('video');
    const cv = document.createElement('video');
    [[sv, screenTrack], [cv, camTrack]].forEach(([v, t]) => {
      v.muted = true; v.playsInline = true;
      v.srcObject = new MediaStream([t]);
      v.play().catch(() => {});
    });
    const stream = canvas.captureStream(30);
    const timer = setInterval(() => paint(sv, cv), 1000 / 30);
    comp.track = stream.getVideoTracks()[0];
    comp.stop = () => { clearInterval(timer); sv.srcObject = null; cv.srcObject = null; comp.track.stop(); };
  }

  if ('contentHint' in comp.track) comp.track.contentHint = 'detail';
  return comp;
}

/* ---------- lifecycle ---------- */

function cleanup() {
  if (rec.compositor) { rec.compositor.stop(); rec.compositor = null; }
  rec.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  rec.streams = [];
  if (rec.audioCtx) { rec.audioCtx.close().catch(() => {}); rec.audioCtx = null; }
  rec.sourceTrack = null;
}

async function start({ opts, source }) {
  if (rec.recorder) return { ok: false, error: 'Already recording.' };

  let screen = null, cam = null, mic = null;
  try {
    if (source) {
      try {
        screen = await getScreenStream(source);
        rec.streams.push(screen);
      } catch (err) {
        cleanup();
        return { ok: false, error: `Capture failed — ${err.message}`, raw: err.message };
      }
    }
    if (opts.mode !== 'screen') {
      cam = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(opts.camId && opts.camId !== 'default' ? { deviceId: { exact: opts.camId } } : {}),
          width: { ideal: 1280 }, height: { ideal: 720 },
        },
      });
      rec.streams.push(cam);
    }
    if (opts.micId !== 'none') {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(opts.micId && opts.micId !== 'default' ? { deviceId: { exact: opts.micId } } : {}),
          echoCancellation: true, noiseSuppression: true,
        },
      });
      rec.streams.push(mic);
    }
  } catch (err) {
    cleanup();
    const needsGrant = err.name === 'NotAllowedError' || err.name === 'NotFoundError';
    return {
      ok: false,
      error: needsGrant
        ? 'Camera or microphone access was refused. Open the extension options page to grant it once.'
        : `Couldn't open the devices: ${err.message}`,
      needsGrant,
    };
  }

  const sourceTrack = (screen || cam).getVideoTracks()[0];
  if (screen && 'contentHint' in sourceTrack) sourceTrack.contentHint = 'detail';
  rec.sourceTrack = sourceTrack;

  let videoTrack = sourceTrack;
  if (screen && cam) {
    try {
      rec.compositor = createCompositor(sourceTrack, cam.getVideoTracks()[0]);
      videoTrack = rec.compositor.track;
    } catch (err) {
      tell({ t: 'warn', message: `Couldn't add the camera to the picture: ${err.message}` });
    }
  }

  // Mix every audio source into one track, and keep tab audio audible to you:
  // chrome.tabCapture silently mutes the tab otherwise.
  const audioTracks = [...(screen?.getAudioTracks() || []), ...(mic?.getAudioTracks() || [])];
  let audioTrack = null;
  if (audioTracks.length) {
    const ctx = new AudioContext();
    rec.audioCtx = ctx;
    const dest = ctx.createMediaStreamDestination();
    audioTracks.forEach((t) => ctx.createMediaStreamSource(new MediaStream([t])).connect(dest));
    if (source?.kind === 'tab' && screen?.getAudioTracks().length) {
      screen.getAudioTracks().forEach((t) => {
        ctx.createMediaStreamSource(new MediaStream([t])).connect(ctx.destination);
      });
    }
    audioTrack = dest.stream.getAudioTracks()[0];
  }

  const mime = pickMime();
  try {
    rec.recorder = new MediaRecorder(new MediaStream([videoTrack, audioTrack].filter(Boolean)), {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 128_000,
    });
  } catch (err) {
    cleanup();
    return { ok: false, error: `This combination can't be recorded: ${err.message}` };
  }

  rec.mime = rec.recorder.mimeType || mime || 'video/webm';
  rec.chunks = [];
  rec.meta = { mode: opts.mode, createdAt: Date.now() };
  rec.recorder.ondataavailable = (e) => { if (e.data?.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = finish;
  // Stopping the share from Chrome's own bar ends the take.
  sourceTrack.addEventListener('ended', () => stop());

  rec.recorder.start(1000);
  rec.elapsed = 0;
  rec.startedAt = Date.now();
  return { ok: true, startedAt: rec.startedAt };
}

function stop() {
  const r = rec.recorder;
  if (!r || r.state === 'inactive') return { ok: false, error: 'Nothing is recording.' };
  if (rec.startedAt) { rec.elapsed += Date.now() - rec.startedAt; rec.startedAt = 0; }
  r.stop();
  return { ok: true };
}

function pause() {
  const r = rec.recorder;
  if (!r) return { ok: false };
  if (r.state === 'recording') {
    r.pause();
    rec.elapsed += Date.now() - rec.startedAt;
    rec.startedAt = 0;
    return { ok: true, status: 'paused', elapsed: rec.elapsed };
  }
  if (r.state === 'paused') {
    r.resume();
    rec.startedAt = Date.now();
    return { ok: true, status: 'recording', startedAt: rec.startedAt, elapsed: rec.elapsed };
  }
  return { ok: false };
}

async function finish() {
  const durationMs = rec.elapsed;
  const type = rec.mime.split(';')[0] || 'video/webm';
  const blob = new Blob(rec.chunks, { type });
  rec.chunks = [];
  rec.recorder = null;
  cleanup();

  const id = LooplessDB.newId();
  const createdAt = rec.meta?.createdAt || Date.now();
  const stamp = new Date(createdAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  try {
    await LooplessDB.put({
      id,
      title: `Recording ${stamp}`,
      mime: type,
      ext: type.includes('mp4') ? 'mp4' : 'webm',
      bytes: blob.size,
      durationMs,
      createdAt,
      mode: rec.meta?.mode || 'screen',
      drive: null,
      blob,
    });
    tell({ t: 'finished', id, bytes: blob.size, durationMs });
  } catch (err) {
    tell({ t: 'finished', error: `The recording couldn't be stored: ${err.message}` });
  }
  rec.meta = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'recorder') return;
  (async () => {
    switch (msg.t) {
      case 'start': sendResponse(await start(msg)); break;
      case 'stop': sendResponse(stop()); break;
      case 'pause': sendResponse(pause()); break;
      case 'ping': sendResponse({ ok: true, recording: !!rec.recorder, elapsed: elapsedNow() }); break;
      default: sendResponse({ ok: false, error: 'Unknown command.' });
    }
  })();
  return true;
});
