const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');
const dotEl = document.getElementById('dot');
const errorEl = document.getElementById('error');
const detectedEl = document.getElementById('detected');

const RETRY_DELAYS = [800, 1500, 2500, 4000, 6000];
const state = { tabId: null, tabUrl: '', pageTitle: 'video', connected: false, attempts: 0, timer: null };

function setStatus(connected, code = '', error = '') {
  state.connected = !!connected;
  statusEl.textContent = connected ? 'Connected to Meldrix' : (code === 'CONNECTING' ? 'Connecting to Meldrix…' : 'Meldrix is not running');
  dotEl.className = connected ? 'dot on' : 'dot';
  if (connected) {
    detailEl.textContent = 'Browser downloads and media are sent automatically.';
    errorEl.textContent = '';
    return;
  }
  if (code === 'DESKTOP_TIMEOUT' || code === 'LAUNCH_FAILED') {
    detailEl.textContent = 'Meldrix is starting. Waiting for the desktop to become ready…';
  } else {
    detailEl.textContent = 'Meldrix starts automatically when you send a download. You can also open it now.';
  }
  errorEl.textContent = error && code !== 'CONNECTING' ? error : '';
}

function scheduleRecovery() {
  if (state.timer) clearTimeout(state.timer);
  if (state.connected) return;
  if (state.attempts >= RETRY_DELAYS.length) return;
  const delay = RETRY_DELAYS[state.attempts++];
  state.timer = setTimeout(() => {
    state.timer = null;
    refresh({ quiet: true });
  }, delay);
}

function runtimeMessage(message) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({ ok: false, code: /context invalidated/i.test(error.message || '') ? 'EXTENSION_UPDATED' : 'NO_RESPONSE', error: /context invalidated/i.test(error.message || '') ? 'Meldrix was updated. Reopen this popup.' : 'Could not reach the Meldrix extension.' });
          return;
        }
        resolve(response || { ok: false, code: 'NO_RESPONSE', error: 'Meldrix did not respond.' });
      });
    } catch {
      resolve({ ok: false, code: 'EXTENSION_UPDATED', error: 'Meldrix was updated. Reopen this popup.' });
    }
  });
}

function refresh(options = {}) {
  if (!options.quiet) {
    statusEl.textContent = 'Checking Meldrix…';
    dotEl.className = 'dot';
  }
  runtimeMessage({ type: 'health' }).then(response => {
    const connected = !!(response && response.connected);
    setStatus(connected, response && response.code, response && response.error);
    if (response && response.settings) applyToggles(response.settings);
    if (connected) {
      state.attempts = 0;
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      loadDetections();
    } else {
      scheduleRecovery();
    }
  }).catch(() => {
    setStatus(false, 'NO_RESPONSE', 'Could not reach the Meldrix extension.');
    scheduleRecovery();
  });
}

function applyToggles(settings) {
  if (typeof settings.intercept === 'boolean') document.getElementById('intercept').checked = settings.intercept;
  if (typeof settings.overlay === 'boolean') document.getElementById('overlay').checked = settings.overlay;
}

function formatBytes(size) {
  if (!size) return '';
  if (size >= 1e9) return `${(size / 1e9).toFixed(1)} GB`;
  if (size >= 1e6) return `${(size / 1e6).toFixed(1)} MB`;
  return `${(size / 1e3).toFixed(0)} KB`;
}

function metaFor(variant, result) {
  const parts = [];
  if (variant.height) parts.push(`${variant.width ? `${variant.width}×` : ''}${variant.height}p`);
  if (variant.container) parts.push(variant.container);
  if (variant.codecs) parts.push(variant.codecs);
  if (variant.bandwidth) parts.push(`${(variant.bandwidth / 1e6).toFixed(1)} Mbps`);
  const size = variant.size || (variant.kind === 'file' ? result.size : 0);
  if (size) parts.push(formatBytes(size));
  if (variant.audioOnly) parts.push('audio only');
  if (variant.unsupported) parts.push(variant.unsupported);
  return parts.join(' · ');
}

function extensionFor(result, variant) {
  const kind = variant.kind || result.kind;
  if (kind === 'hls') return variant.audioOnly ? '.m4a' : '.mp4';
  if (kind === 'dash') return variant.container === 'WebM' ? '.webm' : variant.audioOnly ? '.m4a' : '.mp4';
  const match = /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|wav|flac|ogg)(?:[?#]|$)/i.exec(variant.url);
  return match ? `.${match[1].toLowerCase()}` : '.mp4';
}

function desiredName(result, variant) {
  const title = (state.pageTitle || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
  const filename = variant.filename || result.filename || '';
  if (/\.(mp4|webm|mov|mkv|m4v|mp3|m4a|wav|flac|ogg)(?:[?#]|$)/i.test(filename)) {
    if (variant.height) return filename.replace(/(\.[a-z0-9]+)(?:[?#].*)?$/i, `-${variant.height}p$1`);
    return filename.replace(/[?#].*$/, '');
  }
  const suffix = variant.height ? `-${variant.height}p` : variant.audioOnly ? '-audio' : '';
  return `${title}${suffix}${extensionFor(result, variant)}`;
}

function requestIdFor(url, quality) {
  let hash = 5381;
  const value = `${url}|${quality || ''}`;
  for (let index = 0; index < value.length; index++) hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  return `popup-${hash.toString(36)}`;
}

function enqueue(payload, action, note) {
  return new Promise(resolve => {
    if (action) {
      action.disabled = true;
      action.textContent = 'Sending…';
    }
    const slow = setTimeout(() => {
      if (action) action.textContent = 'Starting Meldrix…';
      if (note) note.textContent = 'Waiting for the desktop app to become ready…';
    }, 1500);
    runtimeMessage({ type: 'enqueue', ...payload }).then(response => {
      clearTimeout(slow);
      const ok = !!(response && response.ok);
      if (ok) {
        setStatus(true);
        state.attempts = 0;
      } else {
        setStatus(false, response && response.code, response && response.error);
        scheduleRecovery();
      }
      resolve({ ok, code: (response && response.code) || '', error: (response && response.error) || '' });
    });
  });
}

function probe(url) {
  return runtimeMessage({ type: 'media:probe', url });
}

function addRetry(panel, load) {
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'action';
  retry.textContent = 'Try again';
  retry.style.marginTop = '5px';
  retry.onclick = () => { retry.disabled = true; load(); };
  panel.appendChild(retry);
}

function showQualityPanel(row, item) {
  const panel = document.createElement('div');
  panel.className = 'quality-panel';
  row.appendChild(panel);

  const load = async () => {
    panel.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'quality-note';
    loading.textContent = 'Reading available formats…';
    panel.appendChild(loading);
    const response = await probe(item.url);
    panel.innerHTML = '';
    if (!response.ok) {
      const error = document.createElement('div');
      error.className = 'quality-error';
      error.textContent = response.error || 'Could not read the media source.';
      panel.appendChild(error);
      addRetry(panel, load);
      return;
    }
    const result = response.result;
    if (result.drm || result.live || !result.variants || !result.variants.length) {
      const error = document.createElement('div');
      error.className = 'quality-error';
      error.textContent = result.error || 'No downloadable format was found. Protected or DRM media is not supported.';
      panel.appendChild(error);
      addRetry(panel, load);
      return;
    }
    const heading = document.createElement('p');
    heading.className = 'quality-note';
    heading.textContent = `${result.kind === 'hls' ? 'HLS' : result.kind === 'dash' ? 'DASH' : 'Direct media'} · ${result.variants.length} discovered format${result.variants.length === 1 ? '' : 's'}`;
    panel.appendChild(heading);
    if (result.error) {
      const warning = document.createElement('div');
      warning.className = 'quality-error';
      warning.textContent = result.error;
      panel.appendChild(warning);
    }
    result.variants.forEach(variant => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'quality-option';
      option.disabled = !!variant.unsupported;
      const main = document.createElement('span');
      main.className = 'q-main';
      const title = document.createElement('b');
      title.textContent = variant.label;
      const meta = document.createElement('small');
      meta.textContent = metaFor(variant, result);
      main.append(title, meta);
      const action = document.createElement('span');
      action.className = 'dl';
      action.textContent = variant.unsupported ? 'Unsupported' : 'Download';
      option.append(main, action);
      option.onclick = async () => {
        option.disabled = true;
        action.textContent = 'Sending…';
        const tagged = { ...variant, kind: result.kind, filename: variant.filename || result.filename || '' };
        const sent = await enqueue({
          url: variant.url,
          name: desiredName(result, tagged),
          mimeType: variant.mimeType || result.mimeType || '',
          kind: result.kind === 'hls' ? 'hls' : 'file',
          quality: variant.label,
          size: variant.size || result.size || 0,
          referrer: state.tabUrl,
          source: 'popup',
          requestId: requestIdFor(variant.url, variant.label)
        }, null, heading);
        if (sent.ok) {
          action.textContent = 'Sent';
          heading.textContent = 'Sent to Meldrix — review the Add Download dialog in the desktop app.';
        } else {
          option.disabled = false;
          action.textContent = 'Try again';
          const error = document.createElement('div');
          error.className = 'quality-error';
          error.textContent = sent.error;
          panel.appendChild(error);
        }
      };
      panel.appendChild(option);
    });
  };
  load();
}

async function sendDirect(item, button) {
  const initial = button.textContent;
  button.disabled = true;
  button.textContent = 'Reading…';
  const probed = await probe(item.url);
  if (probed.ok && probed.result && !probed.result.drm && !probed.result.live && probed.result.variants && probed.result.variants.length === 1 && !probed.result.variants[0].unsupported) {
    const result = probed.result;
    const variant = { ...result.variants[0], kind: result.kind, filename: result.variants[0].filename || result.filename || item.filename || '' };
    const sent = await enqueue({
      url: variant.url || item.url,
      name: desiredName(result, variant),
      mimeType: variant.mimeType || item.mimeType || result.mimeType || '',
      kind: result.kind === 'hls' ? 'hls' : 'file',
      quality: variant.label,
      size: variant.size || result.size || item.size || 0,
      referrer: state.tabUrl,
      source: 'popup',
      requestId: requestIdFor(variant.url || item.url, variant.label)
    }, button, null);
    button.textContent = sent.ok ? 'Sent' : 'Try again';
    if (!sent.ok) button.disabled = false;
    return;
  }
  button.disabled = false;
  button.textContent = initial;
  showQualityPanel(button.closest('.item'), item);
}

function loadDetections() {
  if (state.tabId == null) return;
  runtimeMessage({ type: 'detections:get', tabId: state.tabId }).then(response => {
    const items = (response && response.items) || [];
    if (!items.length) {
      detectedEl.innerHTML = '<div class="empty-detected">No downloadable media detected. Start video playback, then reopen this popup.</div>';
      return;
    }
    detectedEl.innerHTML = '';
    items.slice(0, 10).forEach(item => {
      const row = document.createElement('div');
      row.className = 'item';
      const name = document.createElement('span');
      name.className = 'name';
      const file = item.filename || item.url.split('/').pop().split('?')[0] || item.url;
      const kind = item.manifest ? item.kind.toUpperCase() : (item.mimeType || '').split('/')[1] || 'FILE';
      name.textContent = `${file} · ${kind}${item.size ? ` · ${formatBytes(item.size)}` : ''}`;
      name.title = item.url;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'action';
      if (item.manifest) {
        button.textContent = 'Qualities';
        button.onclick = () => { button.disabled = true; button.textContent = 'Reading…'; showQualityPanel(row, item); };
      } else {
        button.textContent = 'Send';
        button.onclick = () => sendDirect(item, button);
      }
      row.append(name, button);
      detectedEl.appendChild(row);
    });
  }).catch(() => {
    detectedEl.innerHTML = '<div class="empty-detected">Could not read detected media. Reopen this popup.</div>';
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const tab = tabs && tabs[0];
  state.tabId = tab ? tab.id : null;
  state.tabUrl = tab ? tab.url || '' : '';
  state.pageTitle = tab ? tab.title || 'video' : 'video';
  loadDetections();
});

chrome.storage.local.get({ intercept: true, overlay: true }, values => {
  document.getElementById('intercept').checked = !!values.intercept;
  document.getElementById('overlay').checked = !!values.overlay;
});

function updateSetting(key, value) {
  chrome.storage.local.set({ [key]: value });
  runtimeMessage({ type: 'settings', values: { [key]: value } }).then(response => {
    if (response && typeof response.connected === 'boolean') {
      setStatus(response.connected, response.code, response.error);
      if (!response.connected) scheduleRecovery();
    }
  });
}

document.getElementById('intercept').addEventListener('change', event => updateSetting('intercept', event.target.checked));
document.getElementById('overlay').addEventListener('change', event => updateSetting('overlay', event.target.checked));

document.getElementById('open').onclick = () => {
  runtimeMessage({ type: 'show' }).then(response => {
    if (response && response.ok) {
      setStatus(true);
      state.attempts = 0;
      [600, 1500, 3000, 5000].forEach(delay => setTimeout(() => refresh({ quiet: true }), delay));
    } else {
      setStatus(false, response && response.code, response && response.error);
      scheduleRecovery();
    }
  });
};
document.getElementById('retry').onclick = () => {
  state.attempts = 0;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  refresh();
  loadDetections();
};
document.getElementById('settings').onclick = () => chrome.runtime.openOptionsPage();

setStatus(false, 'CONNECTING');
refresh();
