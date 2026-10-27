/* Setup page. Its only real job is to call getUserMedia once from a visible
   extension page before the first take, so the recorder window never stalls
   on a prompt while starting. The grant is per-origin, so once it is given
   here the recorder has it. */

const $ = (id) => document.getElementById(id);

function setState(el, text, good) {
  el.textContent = text;
  el.className = `state ${good ? 'ok' : 'bad'}`;
}

async function checkMedia() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const media = devices.filter((d) => d.kind === 'audioinput' || d.kind === 'videoinput');
    const granted = media.length > 0 && media.every((d) => d.label);
    setState($('mediaState'), granted ? 'Granted' : 'Not granted yet', granted);
    $('grantBtn').textContent = granted ? 'Check again' : 'Grant access';
    return granted;
  } catch {
    setState($('mediaState'), 'Unavailable', false);
    return false;
  }
}

$('grantBtn').onclick = async () => {
  $('mediaError').hidden = true;
  $('grantBtn').disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const preview = $('preview');
    preview.srcObject = stream;
    preview.hidden = false;
    await preview.play().catch(() => {});
    // Hold the preview briefly so you can see it works, then release the devices.
    setTimeout(() => {
      stream.getTracks().forEach((t) => t.stop());
      preview.srcObject = null;
      preview.hidden = true;
    }, 4000);
  } catch (err) {
    $('mediaError').textContent = err.name === 'NotAllowedError'
      ? 'Access was blocked. Click the camera icon in the address bar and allow it for this page, then try again.'
      : `Couldn’t open the devices: ${err.message}`;
    $('mediaError').hidden = false;
  }
  $('grantBtn').disabled = false;
  checkMedia();
};

async function checkDrive() {
  const on = await Drive.connected();
  setState($('driveState'), on ? 'Connected' : 'Not connected', on);
  $('driveBtn').textContent = on ? 'Disconnect' : 'Connect Google Drive';
  return on;
}

$('driveBtn').onclick = async () => {
  $('driveError').hidden = true;
  $('driveBtn').disabled = true;
  try {
    if (await Drive.connected()) await Drive.disconnect();
    else await Drive.connect();
  } catch (err) {
    $('driveError').textContent = err.message;
    $('driveError').hidden = false;
  }
  $('driveBtn').disabled = false;
  checkDrive();
};

checkMedia();
checkDrive();
