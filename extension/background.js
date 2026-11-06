// Meldrix browser bridge (protocol v2).
//
// The service worker owns one Native Messaging port. Every request has a
// correlated id, a bounded timeout, and at most three attempts. The native host
// launches the desktop app when needed and the extension only reports success
// after the desktop acknowledges the request. A periodic alarm reconnects after
// service-worker suspension or a browser restart.
const PROTOCOL_VERSION = 2;
const HOST = 'com.meldrix.downloadmanager';
const CLIENT = 'meldrix-extension/0.2.0';
const KEEPALIVE_ALARM = 'meldrix-bridge-keepalive';
const SUPPORTED = /\.(mp4|m4v|webm|mov|mkv|avi|flv|wmv|mp3|m4a|wav|flac|ogg|aac|opus|zip|rar|7z|tar|gz|exe|msi|apk|pdf|docx?|xlsx?|pptx?|txt|csv)(?:[?#].*)?$/i;
const BROWSER = /Edg\//i.test(navigator.userAgent) ? 'edge' : 'chrome';
const TIMEOUTS = {
  handshake: 22000,
  enqueue: 25000,
  health: 18000,
  show: 15000,
  settings: 15000
};
const MAX_ATTEMPTS = 3;
const RECENT_TTL = 90000;
const TRANSIENT = new Set(['DISCONNECTED', 'PIPE_ERROR', 'DESKTOP_NOT_RUNNING', 'DESKTOP_TIMEOUT', 'LAUNCH_FAILED', 'HOST_EXITED', 'UNSUPPORTED_VERSION']);

let port = null;
let connected = false;
let connecting = null;
let lastReadyAt = 0;
let lastError = '';
let lastCode = '';
let seq = 0;
const pending = new Map();
const inflight = new Map();
const recent = new Map();
const detections = new Map();
const settings = { intercept: true, overlay: true, confirmBeforeDownload: true };

chrome.storage.local.get({ intercept: true, overlay: true, confirmBeforeDownload: true }).then(value => Object.assign(settings, value)).catch(() => {});
chrome.storage.onChanged.addListener(changes => {
  if (changes.intercept) settings.intercept = !!changes.intercept.newValue;
  if (changes.overlay) settings.overlay = !!changes.overlay.newValue;
  if (changes.confirmBeforeDownload) settings.confirmBeforeDownload = !!changes.confirmBeforeDownload.newValue;
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function friendly(code, message) {
  const text = String(message || '');
  switch (code) {
    case 'HOST_NOT_REGISTERED':
      return 'Meldrix Native Messaging is not registered. Reinstall Meldrix, then reload this extension.';
    case 'LAUNCH_FAILED':
      return 'Meldrix could not be started. Open Meldrix once, then try again.';
    case 'DESKTOP_TIMEOUT':
      return 'Meldrix is starting but was not ready in time. It may still be loading; try again in a moment.';
    case 'DESKTOP_NOT_RUNNING':
    case 'PIPE_ERROR':
    case 'HOST_EXITED':
      return 'Meldrix is not running. It starts automatically when you send a download.';
    case 'DISCONNECTED':
      return 'Lost the connection to Meldrix. Reconnecting automatically…';
    case 'UNSUPPORTED_VERSION':
      return 'The Meldrix extension and desktop app versions do not match. Update Meldrix and reload this extension.';
    case 'UNSUPPORTED_TYPE':
      return 'This page is running an older Meldrix script. Reload the page once to finish updating.';
    case 'INVALID_URL':
      return text || 'Only HTTP and HTTPS links can be downloaded.';
    case 'INVALID_REQUEST':
    case 'INVALID_MESSAGE':
    case 'INVALID_SETTINGS':
      return text || 'Meldrix rejected an invalid request.';
    case 'DESKTOP_ERROR':
      return text || 'Meldrix could not complete the request.';
    default:
      if (/host not found|not registered|Specified native messaging host/i.test(text)) return friendly('HOST_NOT_REGISTERED', text);
      if (/forbidden|Access to the specified native messaging host/i.test(text)) return 'This extension ID is not allowed by the Meldrix host. Reinstall Meldrix.';
      if (/has exited|not running|ECONNREFUSED|pipe|connection|disconnected/i.test(text)) return friendly('DESKTOP_NOT_RUNNING', text);
      return text || 'Meldrix could not complete the request.';
  }
}

function errorResult(code, message, extra = {}) {
  const value = { ok: false, code, error: friendly(code, message), ...extra };
  lastCode = code;
  lastError = value.error;
  return value;
}

function applyDesktopSettings(value) {
  if (!value) return;
  if (typeof value.intercept === 'boolean') settings.intercept = value.intercept;
  if (typeof value.overlay === 'boolean') settings.overlay = value.overlay;
  if (typeof value.confirmBeforeDownload === 'boolean') settings.confirmBeforeDownload = value.confirmBeforeDownload;
  chrome.storage.local.set(settings).catch(() => {});
}

function failPending(code, message) {
  const result = errorResult(code, message);
  for (const [id, entry] of pending) {
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }
}

function onNativeMessage(message) {
  if (!message || typeof message !== 'object') return;
  const type = message.type;
  const protocolMismatch = message.version !== PROTOCOL_VERSION || (type === 'error' && /protocol version/i.test(message.error || ''));
  if (protocolMismatch) {
    connected = false;
    lastCode = 'UNSUPPORTED_VERSION';
    lastError = friendly(lastCode, message.error);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: lastCode, error: lastError });
    }
    return;
  }
  if (type === 'ready' || type === 'pong') {
    connected = true;
    lastReadyAt = Date.now();
    lastError = '';
    lastCode = '';
    applyDesktopSettings(message.settings);
  } else if (type === 'accepted' || type === 'shown' || type === 'settings') {
    connected = true;
    lastReadyAt = Date.now();
  } else if (type === 'error') {
    lastCode = message.code || 'DESKTOP_ERROR';
    lastError = friendly(lastCode, message.error);
  }

  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve({
      ...message,
      ok: type !== 'error' && message.ok === true,
      code: type === 'error' || message.ok !== true ? (message.code || 'DESKTOP_ERROR') : '',
      error: type === 'error' || message.ok !== true ? friendly(message.code, message.error) : ''
    });
  }
}

function openPort() {
  if (port) return port;
  try {
    const next = chrome.runtime.connectNative(HOST);
    port = next;
    connected = false;
    next.onMessage.addListener(onNativeMessage);
    next.onDisconnect.addListener(() => {
      const runtimeError = chrome.runtime.lastError;
      const message = runtimeError && runtimeError.message ? runtimeError.message : '';
      if (port === next) {
        port = null;
        connected = false;
      }
      const code = /not found|not registered|forbidden/i.test(message) ? 'HOST_NOT_REGISTERED' : 'HOST_EXITED';
      failPending(code, message);
    });
    return next;
  } catch (error) {
    port = null;
    connected = false;
    lastCode = /not found|not registered|forbidden/i.test(error && error.message ? error.message : '') ? 'HOST_NOT_REGISTERED' : 'LAUNCH_FAILED';
    lastError = friendly(lastCode, error && error.message ? error.message : '');
    return null;
  }
}

function sendOnPort(message, timeout) {
  return new Promise(resolve => {
    const target = openPort();
    if (!target) {
      resolve(errorResult(lastCode || 'LAUNCH_FAILED', lastError));
      return;
    }
    const id = message.id || `m-${Date.now().toString(36)}-${++seq}`;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve(errorResult('DESKTOP_TIMEOUT', 'Meldrix did not respond in time.'));
    }, timeout);
    pending.set(id, {
      timer,
      resolve: value => {
        clearTimeout(timer);
        resolve(value);
      }
    });
    try {
      target.postMessage({ version: PROTOCOL_VERSION, id, browser: BROWSER, client: CLIENT, ...message });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      resolve(errorResult('DISCONNECTED', error && error.message ? error.message : ''));
    }
  });
}

function closePort() {
  try { if (port) port.disconnect(); } catch { /* already closed */ }
  port = null;
  connected = false;
}

async function handshake(force = false) {
  if (!force && connected && Date.now() - lastReadyAt < 60000) return { ok: true, type: 'ready', cached: true };
  if (connecting) return connecting;
  connecting = (async () => {
    let last = errorResult('DESKTOP_TIMEOUT', 'Meldrix did not become ready.');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (force || attempt) closePort();
      const result = await sendOnPort({ type: 'hello', capabilities: ['review', 'hls', 'dedupe', 'launch'] }, TIMEOUTS.handshake);
      if (result.ok && (result.type === 'ready' || result.type === 'pong')) {
        connected = true;
        lastReadyAt = Date.now();
        lastError = '';
        lastCode = '';
        return result;
      }
      last = result;
      if (!TRANSIENT.has(result.code)) return result;
      if (attempt === 0) await delay(450);
    }
    return last;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function rpc(type, payload = {}, options = {}) {
  const timeout = options.timeout || TIMEOUTS.enqueue;
  const attempts = Math.min(MAX_ATTEMPTS, Math.max(1, options.attempts || 2));
  let last = errorResult('DESKTOP_TIMEOUT', 'Meldrix did not respond.');
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) {
      await delay(400 * attempt + 150);
      closePort();
    }
    const ready = await handshake(attempt > 0);
    if (!ready.ok) {
      last = ready;
      if (!TRANSIENT.has(ready.code)) return ready;
      continue;
    }
    const result = await sendOnPort({ type, ...payload }, timeout);
    if (result.ok) return result;
    last = result;
    if (!TRANSIENT.has(result.code)) return result;
    if (/not registered|forbidden/i.test(result.error || '')) return result;
  }
  return last;
}

function noteDetection(tabId, url, meta) {
  if (!tabId || tabId < 0) return;
  if (!/^https?:\/\//i.test(url)) return;
  if (!detections.has(tabId)) detections.set(tabId, new Map());
  const list = detections.get(tabId);
  const previous = list.get(url) || {};
  list.set(url, { ...previous, ...meta, url, at: Date.now() });
  while (list.size > 40) list.delete(list.keys().next().value);
  chrome.action.setBadgeBackgroundColor({ color: '#4b6fe0' }).catch(() => {});
  chrome.action.setBadgeText({ text: String(list.size), tabId }).catch(() => {});
}

function header(headers, name) {
  const item = (headers || []).find(value => value && value.name && value.name.toLowerCase() === name);
  return item ? item.value || '' : '';
}

function isManifestUrl(url) {
  return /\.(m3u8|mpd)(?:[?#]|$)/i.test(url);
}

function parseDisposition(value) {
  if (!value) return '';
  const extended = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value);
  if (extended && extended[1]) {
    try { return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  return plain && plain[1] ? plain[1].trim() : '';
}

function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'meldrix-download', title: 'Download with Meldrix', contexts: ['link', 'video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'meldrix-open', title: 'Open Meldrix Download Manager', contexts: ['page'] });
  });
}

async function refreshContentScripts() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }); } catch { return; }
  for (const tab of tabs.slice(0, 40)) {
    if (!tab.id) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch {
      // Restricted pages and discarded tabs are expected to reject injection.
    }
  }
}

function ensureAlarm() {
  try { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 }); } catch { /* alarms unavailable */ }
}

chrome.runtime.onInstalled.addListener(() => {
  registerMenus();
  ensureAlarm();
  handshake(true).catch(() => {});
  refreshContentScripts().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  handshake(true).catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!connected) {
    handshake().catch(() => {});
    return;
  }
  sendOnPort({ type: 'ping' }, TIMEOUTS.health).then(result => {
    if (!result.ok) connected = false;
  }).catch(() => { connected = false; });
});

ensureAlarm();
// A saved port keeps the MV3 worker alive; this also reconnects a fresh worker
// immediately after a browser restart or service-worker suspension.
handshake().catch(() => {});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'meldrix-open') {
    await rpc('show', {}, { timeout: TIMEOUTS.show, attempts: 2 });
    return;
  }
  const url = info.linkUrl || info.srcUrl || (tab && tab.url);
  if (!url || !/^https?:\/\//i.test(url)) return;
  const kind = isManifestUrl(url) ? 'hls' : 'file';
  await rpc('enqueue', {
    url,
    name: '',
    mimeType: '',
    kind,
    referrer: (tab && tab.url) || '',
    source: 'context-menu',
    requestId: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }, { timeout: TIMEOUTS.enqueue, attempts: 3 });
});

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0) return;
  if (/\.(ts|m4s|cmfv|cmfa)(?:[?#]|$)/i.test(details.url)) return;
  const type = header(details.responseHeaders, 'content-type');
  if (/^video\/(mp2t|iso\.segment)/i.test(type)) return;
  const disposition = header(details.responseHeaders, 'content-disposition');
  const rawLength = Number(header(details.responseHeaders, 'content-length') || 0);
  const size = Number.isFinite(rawLength) && rawLength > 0 ? rawLength : 0;
  const manifest = /(mpegurl|dash\+xml)/i.test(type) || isManifestUrl(details.url);
  const media = /^(video|audio)\//i.test(type) && !manifest;
  const attachment = /attachment/i.test(disposition);
  const extensionMatch = SUPPORTED.test(details.url.split('?')[0]);
  const binary = /application\/(pdf|zip|x-zip-compressed|vnd\.ms-)/i.test(type);
  const octet = /application\/octet-stream/i.test(type) && (attachment || extensionMatch);
  if (manifest) {
    noteDetection(details.tabId, details.url, {
      kind: /dash\+xml|\.mpd/i.test(`${type} ${details.url}`) ? 'dash' : 'hls',
      mimeType: type.split(';')[0].trim(),
      size,
      manifest: true,
      media: false,
      filename: parseDisposition(disposition)
    });
  } else if (media || attachment || binary || octet) {
    noteDetection(details.tabId, details.url, {
      kind: 'file',
      mimeType: type.split(';')[0].trim(),
      size,
      manifest: false,
      media,
      attachment,
      filename: parseDisposition(disposition)
    });
  }
}, { urls: ['<all_urls>'], types: ['media', 'object', 'xmlhttprequest', 'main_frame', 'sub_frame'] }, ['responseHeaders']);

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  if (!isManifestUrl(details.url)) return;
  noteDetection(details.tabId, details.url, {
    kind: /\.mpd(?:[?#]|$)/i.test(details.url) ? 'dash' : 'hls',
    mimeType: '',
    size: 0,
    manifest: true,
    media: false
  });
}, { urls: ['<all_urls>'], types: ['media', 'object', 'xmlhttprequest'] });

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    detections.delete(tabId);
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  } else if (changeInfo.status === 'complete' && tab && /^https?:/i.test(tab.url || '')) {
    chrome.tabs.sendMessage(tabId, { type: 'rescan' }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(tabId => detections.delete(tabId));

chrome.downloads.onCreated.addListener(async item => {
  if (!settings.intercept) return;
  const url = item.finalUrl || item.url;
  const suggested = (item.filename || '').split(/[\\/]/).pop() || '';
  if (!/^https?:\/\//i.test(url) || (!SUPPORTED.test(url) && !SUPPORTED.test(suggested))) return;
  let paused = false;
  try { await chrome.downloads.pause(item.id); paused = true; } catch { /* already finished */ }
  const result = await rpc('enqueue', {
    type: 'enqueue',
    url,
    name: suggested,
    mimeType: item.mime || '',
    kind: 'file',
    referrer: item.referrer || '',
    source: 'download',
    size: item.fileSize > 0 ? item.fileSize : 0,
    requestId: `download-${item.id}`
  }, { timeout: TIMEOUTS.enqueue, attempts: 3 });
  if (result.ok) {
    try { await chrome.downloads.cancel(item.id); await chrome.downloads.erase({ id: item.id }); } catch { /* already gone */ }
    chrome.action.setBadgeText({ text: '✓' }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 2500);
  } else if (paused) {
    try { await chrome.downloads.resume(item.id); } catch { /* already gone */ }
  }
});

function attrsOf(text) {
  const attributes = {};
  const pattern = /([A-Za-z0-9:_-]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(text))) attributes[match[1].toUpperCase()] = match[2];
  return attributes;
}

function hlsAttrs(text) {
  const attributes = {};
  const pattern = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = pattern.exec(text))) attributes[match[1].toUpperCase()] = String(match[2]).replace(/^"|"$/g, '').trim();
  return attributes;
}

function labelFor(height, bandwidth, audioOnly, frameRate) {
  if (height >= 2160) return `2160p${frameRate >= 50 ? Math.round(frameRate) : ''} (4K)`;
  if (height) return `${height}p${frameRate >= 50 ? Math.round(frameRate) : ''}`;
  if (audioOnly) return 'Audio only';
  return 'Original quality';
}

function parseHls(text, baseUrl) {
  if (/#EXT-X-(?:SESSION-)?KEY:[^\r\n]*METHOD=(?!NONE\b)/i.test(text)) {
    return { kind: 'hls', url: baseUrl, drm: true, error: 'This HLS stream is encrypted. DRM and encrypted media are not supported.', variants: [] };
  }
  if (!/#EXT-X-STREAM-INF:/i.test(text)) {
    if (!/#EXT-X-ENDLIST/i.test(text) && !/#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(text)) {
      return { kind: 'hls', url: baseUrl, live: true, error: 'Live HLS streams are not supported.', variants: [] };
    }
    return {
      kind: 'hls',
      url: baseUrl,
      variants: [{ id: 'original', url: baseUrl, label: 'Original quality', container: 'HLS', mimeType: 'application/vnd.apple.mpegurl', size: 0, width: 0, height: 0, bandwidth: 0, codecs: '', audioOnly: false }]
    };
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const variants = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].startsWith('#EXT-X-MEDIA:')) {
      const attributes = hlsAttrs(lines[index].slice('#EXT-X-MEDIA:'.length));
      if (attributes.TYPE !== 'AUDIO' || !attributes.URI) continue;
      variants.push({
        id: `audio-${variants.length}`,
        url: new URL(attributes.URI, baseUrl).toString(),
        label: `Audio only${attributes.NAME ? ` · ${attributes.NAME}` : attributes.LANGUAGE ? ` · ${attributes.LANGUAGE}` : ''}`,
        container: 'HLS audio',
        mimeType: 'audio/mpegurl',
        size: 0,
        width: 0,
        height: 0,
        bandwidth: 0,
        codecs: attributes.CHANNELS ? `${attributes.CHANNELS} channels` : '',
        audioOnly: true
      });
      continue;
    }
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attributes = hlsAttrs(lines[index].slice('#EXT-X-STREAM-INF:'.length));
    let next = index + 1;
    while (next < lines.length && lines[next].startsWith('#')) next++;
    if (!lines[next]) continue;
    const resolution = /^(\d+)x(\d+)$/.exec(attributes.RESOLUTION || '') || [];
    const width = Number(resolution[1] || 0);
    const height = Number(resolution[2] || 0);
    const bandwidth = Number(attributes.BANDWIDTH || attributes['AVERAGE-BANDWIDTH'] || 0);
    const frameRate = Number(attributes['FRAME-RATE'] || 0);
    const codecs = attributes.CODECS || '';
    const audioOnly = !height && /audio|mp4a|ac-3|ec-3|opus|flac|vorbis/i.test(codecs);
    variants.push({
      id: `variant-${variants.length}`,
      url: new URL(lines[next], baseUrl).toString(),
      label: labelFor(height, bandwidth, audioOnly, frameRate),
      container: 'HLS',
      mimeType: audioOnly ? 'audio/mpegurl' : 'video/mp4',
      size: 0,
      width,
      height,
      bandwidth,
      frameRate,
      codecs,
      audioOnly
    });
    index = next;
  }
  const seen = new Set();
  const unique = variants.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  if (!unique.length) return { kind: 'hls', url: baseUrl, error: 'No playable HLS variants were found.', variants: [] };
  return { kind: 'hls', url: baseUrl, variants: unique };
}

function parseDash(xml, baseUrl) {
  const rootBaseMatch = /<MPD\b[\s\S]*?<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(xml);
  const rootBase = rootBaseMatch ? new URL(rootBaseMatch[1].trim(), baseUrl).toString() : baseUrl;
  if (/<ContentProtection\b/i.test(xml)) {
    return { kind: 'dash', url: baseUrl, drm: true, error: 'This DASH stream is DRM protected. Protected media is not supported.', variants: [] };
  }
  const variants = [];
  const adaptation = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
  let set;
  while ((set = adaptation.exec(xml))) {
    const setAttrs = attrsOf(set[1]);
    const setBaseMatch = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(set[2]);
    const setBase = setBaseMatch ? new URL(setBaseMatch[1].trim(), rootBase).toString() : rootBase;
    const representation = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
    let rep;
    while ((rep = representation.exec(set[2]))) {
      const repAttrs = { ...setAttrs, ...attrsOf(rep[1]) };
      const body = rep[2];
      const base = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(body);
      if (!base && !setBaseMatch && !rootBaseMatch) continue;
      const url = new URL(base ? base[1].trim() : '', setBase).toString();
      if (!/^https?:/i.test(url)) continue;
      const mimeType = repAttrs.MIMETYPE || setAttrs.MIMETYPE || '';
      const codecs = repAttrs.CODECS || setAttrs.CODECS || '';
      const height = Number(repAttrs.HEIGHT || setAttrs.HEIGHT || 0);
      const width = Number(repAttrs.WIDTH || setAttrs.WIDTH || 0);
      const bandwidth = Number(repAttrs.BANDWIDTH || 0);
      const audioOnly = /^audio\//i.test(mimeType) || (!height && /mp4a|opus|ac-3|ec-3|flac/i.test(codecs));
      const segmented = /<Segment(Template|List|Base)\b/i.test(body) || /<SegmentTemplate\b[^>]*media=/i.test(set[2]);
      variants.push({
        id: `dash-${variants.length}`,
        url,
        label: labelFor(height, bandwidth, audioOnly, 0),
        container: /webm/i.test(mimeType) ? 'WebM' : /audio\//i.test(mimeType) ? 'M4A' : 'MP4',
        mimeType,
        size: 0,
        width,
        height,
        bandwidth,
        codecs,
        audioOnly,
        unsupported: segmented ? 'Segmented DASH needs muxing; use a direct MP4 rendition instead.' : ''
      });
    }
  }
  const seen = new Set();
  const unique = variants.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  if (!unique.length) return { kind: 'dash', url: baseUrl, error: 'No direct DASH rendition was found. Segmented DASH requires muxing and is not supported.', variants: [] };
  if (unique.every(item => item.unsupported)) {
    return { kind: 'dash', url: baseUrl, error: 'This DASH stream uses segments that require muxing. It cannot be downloaded by the current engine.', variants: unique };
  }
  return { kind: 'dash', url: baseUrl, variants: unique };
}

async function readHeaders(url) {
  const attempt = async method => {
    const response = await fetch(url, {
      method,
      credentials: 'omit',
      redirect: 'follow',
      headers: method === 'GET' ? { Range: 'bytes=0-0' } : {}
    });
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    const range = response.headers.get('content-range') || '';
    const rangeMatch = /\/(\d+)\s*$/.exec(range);
    const length = Number(response.headers.get('content-length') || 0);
    const size = length || (rangeMatch ? Number(rangeMatch[1]) : 0);
    const filename = parseDisposition(response.headers.get('content-disposition') || '');
    if (response.body) await response.body.cancel().catch(() => {});
    return { type: type.split(';')[0].trim(), rawType: type, size, finalUrl: response.url || url, filename };
  };
  try {
    return await attempt('HEAD');
  } catch {
    return attempt('GET');
  }
}

function containerFor(url, mimeType) {
  if (/webm/i.test(mimeType) || /\.webm(?:[?#]|$)/i.test(url)) return 'WebM';
  if (/quicktime|\.mov(?:[?#]|$)/i.test(url)) return 'MOV';
  if (/audio\//i.test(mimeType)) return 'Audio';
  if (/\.mp4(?:[?#]|$)/i.test(url) || /video\/mp4/i.test(mimeType)) return 'MP4';
  if (/\.m4v(?:[?#]|$)/i.test(url)) return 'M4V';
  return 'File';
}

function filenameFrom(input) {
  try {
    const part = new URL(input).pathname.split('/').filter(Boolean).pop();
    return part ? decodeURIComponent(part) : 'download';
  } catch {
    return 'download';
  }
}

async function probeMedia(input) {
  if (typeof input !== 'string' || !/^https?:\/\//i.test(input)) throw new Error('Only HTTP and HTTPS media URLs can be inspected.');
  const url = new URL(input).toString();
  const head = await readHeaders(url);
  const pathname = new URL(head.finalUrl).pathname;
  const isHls = /\.m3u8$/i.test(pathname) || /mpegurl/i.test(head.type);
  const isDash = /\.mpd$/i.test(pathname) || /dash\+xml/i.test(head.type);
  const filename = head.filename || filenameFrom(head.finalUrl);
  if (isHls || isDash) {
    const response = await fetch(head.finalUrl, { credentials: 'omit', redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} while reading the stream manifest.`);
    const text = (await response.text()).slice(0, 2 * 1024 * 1024);
    const finalUrl = response.url || head.finalUrl;
    const parsed = isHls ? parseHls(text, finalUrl) : parseDash(text, finalUrl);
    return { ...parsed, url: finalUrl, mimeType: head.type, filename };
  }
  return {
    kind: 'file',
    url: head.finalUrl,
    mimeType: head.type,
    size: head.size,
    filename,
    variants: [{
      id: 'original',
      url: head.finalUrl,
      label: 'Original quality',
      container: containerFor(head.finalUrl, head.type),
      mimeType: head.type,
      size: head.size,
      width: 0,
      height: 0,
      bandwidth: 0,
      codecs: '',
      audioOnly: /audio\//i.test(head.type)
    }]
  };
}

const LEGACY_TYPES = {
  download: 'enqueue',
  send: 'enqueue',
  getMedia: 'media:tab',
  detect: 'media:tab',
  probe: 'media:probe',
  getDetections: 'detections:get'
};

function sanitizeEnqueue(message) {
  const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128
    ? message.requestId
    : `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    url: typeof message.url === 'string' ? message.url.slice(0, 4096) : '',
    name: typeof message.name === 'string' ? message.name.slice(0, 300) : '',
    mimeType: typeof message.mimeType === 'string' ? message.mimeType.slice(0, 200) : '',
    kind: message.kind === 'hls' ? 'hls' : 'file',
    quality: typeof message.quality === 'string' ? message.quality.slice(0, 200) : '',
    size: Number.isFinite(Number(message.size)) ? Math.max(0, Number(message.size)) : 0,
    referrer: typeof message.referrer === 'string' ? message.referrer.slice(0, 2048) : '',
    source: typeof message.source === 'string' ? message.source.slice(0, 40) : 'content-script',
    requestId
  };
}

function enqueue(message) {
  const payload = sanitizeEnqueue(message);
  if (!/^https?:\/\//i.test(payload.url)) return Promise.resolve(errorResult('INVALID_URL', 'Only HTTP and HTTPS links can be downloaded.'));
  const key = payload.requestId;
  const cached = recent.get(key);
  if (cached && Date.now() - cached.at < RECENT_TTL) return Promise.resolve(cached.value);
  if (inflight.has(key)) return inflight.get(key);
  const promise = rpc('enqueue', payload, { timeout: TIMEOUTS.enqueue, attempts: MAX_ATTEMPTS }).then(result => {
    if (result.ok) recent.set(key, { at: Date.now(), value: result });
    while (recent.size > 80) recent.delete(recent.keys().next().value);
    return result;
  }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function health() {
  const result = await rpc('ping', {}, { timeout: TIMEOUTS.health, attempts: 2 });
  connected = !!result.ok;
  if (!result.ok) {
    lastCode = result.code || 'DESKTOP_TIMEOUT';
    lastError = result.error || friendly(lastCode);
  } else {
    lastError = '';
    lastCode = '';
    lastReadyAt = Date.now();
    applyDesktopSettings(result.settings);
  }
  return {
    ok: !!result.ok,
    connected,
    code: result.code || '',
    error: result.ok ? '' : lastError,
    lastSeen: lastReadyAt,
    app: result.app || '',
    version: result.appVersion || '',
    desktopReady: !!result.desktopReady,
    settings
  };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message !== 'object') {
    reply(errorResult('INVALID_MESSAGE', 'Invalid message'));
    return false;
  }
  const requested = typeof message.type === 'string' ? message.type : '';
  const type = LEGACY_TYPES[requested] || requested;

  (async () => {
    try {
      if (type === 'enqueue') {
        const result = await enqueue(message);
        reply({ ok: !!result.ok, connected, status: result.status || '', id: result.id || '', duplicate: !!result.duplicate, requestId: result.requestId || message.requestId || '', code: result.code || '', error: result.error || '' });
        return;
      }
      if (type === 'media:probe') {
        try {
          reply({ ok: true, result: await probeMedia(message.url) });
        } catch (error) {
          reply({ ok: false, code: 'PROBE_FAILED', error: error.message || 'Could not read the media manifest.' });
        }
        return;
      }
      if (type === 'media:tab') {
        const tabId = sender.tab && sender.tab.id;
        const list = tabId != null ? detections.get(tabId) : null;
        reply({ ok: true, items: list ? Array.from(list.values()).filter(item => item.manifest || item.kind === 'file').reverse() : [] });
        return;
      }
      if (type === 'health') {
        reply(await health());
        return;
      }
      if (type === 'show') {
        const result = await rpc('show', {}, { timeout: TIMEOUTS.show, attempts: 2 });
        reply({ ok: !!result.ok, connected, code: result.code || '', error: result.error || '' });
        return;
      }
      if (type === 'detections:get') {
        const list = detections.get(message.tabId);
        reply({ ok: true, items: list ? Array.from(list.values()).reverse() : [] });
        return;
      }
      if (type === 'settings') {
        const values = {};
        for (const key of ['intercept', 'overlay', 'confirmBeforeDownload']) {
          if (typeof message.values?.[key] === 'boolean') values[key] = message.values[key];
        }
        Object.assign(settings, values);
        chrome.storage.local.set(settings).catch(() => {});
        const result = await rpc('settings:update', { settings: values }, { timeout: TIMEOUTS.settings, attempts: 2 });
        if (result.settings) applyDesktopSettings(result.settings);
        reply({ ok: !!result.ok, connected, code: result.code || '', error: result.error || '', settings });
        return;
      }
      if (type === 'content:version') {
        reply({ ok: true, version: CLIENT });
        return;
      }

      // An old content script from a previous extension version can still be
      // alive in an open tab after an update. Re-inject the current script and
      // return an actionable message instead of a generic "Unknown message".
      if (sender.tab && sender.tab.id != null) {
        chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, files: ['content.js'] }).catch(() => {});
      }
      reply(errorResult('UNSUPPORTED_TYPE', `Meldrix received an unsupported browser request (${requested || 'missing type'}).`));
    } catch (error) {
      reply(errorResult('DESKTOP_ERROR', error && error.message ? error.message : ''));
    }
  })();
  return true;
});
