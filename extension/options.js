const status = document.getElementById('status');
const fields = ['intercept', 'overlay', 'confirmBeforeDownload'];

function message(payload) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(payload, response => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response || { ok: false, error: 'The extension did not respond.' });
    });
  });
}

function showStatus(text, isError = false) {
  status.textContent = text;
  status.dataset.state = isError ? 'error' : 'ok';
}

async function load() {
  const values = await chrome.storage.local.get({
    intercept: true,
    overlay: true,
    confirmBeforeDownload: true
  });
  for (const key of fields) document.getElementById(key).checked = values[key] === true;
  const health = await message({ type: 'health' });
  showStatus(
    health.connected ? 'Connected: a Native Messaging handshake with the Meldrix desktop app succeeded.' :
      `Not connected: ${health.error || 'Install and open Meldrix, then verify its browser integration.'}`,
    !health.connected
  );
}

for (const key of fields) {
  document.getElementById(key).addEventListener('change', async event => {
    const values = Object.fromEntries(fields.map(name => [name, document.getElementById(name).checked]));
    await chrome.storage.local.set(values);
    const result = await message({ type: 'settings', values });
    showStatus(result.ok ? 'Settings saved and synchronized with Meldrix.' : `Saved in this browser. Desktop sync is unavailable: ${result.error || 'open Meldrix and retry.'}`, !result.ok);
  });
}

document.getElementById('test').addEventListener('click', async () => {
  showStatus('Testing the Native Messaging connection…');
  const result = await message({ type: 'health' });
  showStatus(
    result.connected ? 'Connected: Native Messaging handshake succeeded.' :
      `Connection failed: ${result.error || 'Open Meldrix and retry.'}`,
    !result.connected
  );
});

document.getElementById('help').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://github.com/fahadmia20333/dawnload-manager#browser-extension-setup' });
});

load().catch(error => showStatus(error.message || 'Could not load extension settings.', true));
