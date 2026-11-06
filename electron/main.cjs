const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const initSqlJs = require('sql.js');
const log = require('electron-log');

const PIPE_NAME = '\\\\.\\pipe\\meldrix-download-manager';
const PROTOCOL_VERSION = 2;
const NATIVE_HOST_VERSION = '2.0.0';
const EXTENSION_ID = 'lhnjhjehjjocnjjfgnpliffgochpgikk';
const HOST_NAME = 'com.meldrix.downloadmanager';
const REGISTRY_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`
];
const DEFAULT_SETTINGS = {
  default_download_directory: '',
  auto_detect_downloads: '1',
  show_video_button: '1',
  confirm_before_download: '1',
  start_with_windows: '1'
};

let win;
let tray;
let db;
let SQL;
let lastNativeAt = 0;
const lastBrowserAt = { chrome: 0, edge: 0 };
let latestReview = null;
let integrationTimer = null;
let pipeServer = null;
let nativeReadyAt = 0;
const active = new Map();
const pendingReviews = new Map();
const recentNative = new Map();
const nativeConnections = new Set();
const pendingResumes = new Set();

const dataDir = () => app.getPath('userData');

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
  process.exit(0);
}

log.transports.file.level = 'info';
process.on('uncaughtException', error => log.error('uncaughtException', error));
process.on('unhandledRejection', reason => log.error('unhandledRejection', reason));

function saveDb() {
  fs.writeFileSync(path.join(dataDir(), 'meldrix.sqlite'), Buffer.from(db.export()));
}

function run(sql, args = []) {
  db.run(sql, args);
  saveDb();
}

function all(sql, args = []) {
  const statement = db.prepare(sql);
  statement.bind(args);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function one(sql, args = []) {
  return all(sql, args)[0];
}

function setting(key, fallback = '') {
  const row = one('SELECT value FROM settings WHERE key=?', [key]);
  return row && row.value != null ? String(row.value) : fallback;
}

function saveSetting(key, value) {
  run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, String(value)]);
}

function extensionSettings() {
  return {
    intercept: setting('auto_detect_downloads', '1') === '1',
    overlay: setting('show_video_button', '1') === '1',
    confirmBeforeDownload: setting('confirm_before_download', '1') === '1'
  };
}

function categoryFor(name, type = '') {
  const value = `${name || ''} ${type || ''}`.toLowerCase();
  if (/\.(mp4|mkv|webm|mov|avi|m4v|flv|wmv|m3u8|mpd)(\?|$)/.test(value) || type.startsWith('video/') || /mpegurl|dash\+xml/i.test(type)) return 'Video';
  if (/\.(mp3|wav|flac|aac|m4a|ogg|opus)(\?|$)/.test(value) || type.startsWith('audio/')) return 'Audio';
  if (/\.(zip|rar|7z|tar|gz)(\?|$)/.test(value)) return 'Compressed';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv)(\?|$)/.test(value) || type.includes('pdf') || type.startsWith('text/')) return 'Documents';
  if (/\.(exe|msi|dmg|apk)(\?|$)/.test(value)) return 'Programs';
  if (/\.(jpg|jpeg|png|gif|svg|webp|bmp)(\?|$)/.test(value) || type.startsWith('image/')) return 'Pictures';
  return 'All files';
}

function validateUrl(input) {
  if (typeof input !== 'string') throw new Error('Invalid URL');
  const value = input.trim();
  if (value.length < 8 || value.length > 4096) throw new Error('Invalid URL length');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
  if (parsed.username || parsed.password) throw new Error('URLs with embedded credentials are not supported');
  return parsed.toString();
}

function validReferrer(input) {
  if (typeof input !== 'string' || !input) return '';
  try {
    const parsed = new URL(input);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString().slice(0, 2048) : '';
  } catch {
    return '';
  }
}

function filenameFrom(input) {
  try {
    const part = new URL(input).pathname.split('/').filter(Boolean).pop();
    return part ? decodeURIComponent(part) : 'download';
  } catch {
    return 'download';
  }
}

function safeName(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return cleaned || 'download';
}

function dispositionFilename(value) {
  if (!value) return '';
  const extended = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value);
  if (extended && extended[1]) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain filename
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  return plain && plain[1] ? plain[1].trim() : '';
}

const extensionByType = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'application/zip': 'zip',
  'application/pdf': 'pdf'
};

function extensionFor(name, type) {
  if (/\.[a-z0-9]{2,6}$/i.test(name)) return '';
  const extension = extensionByType[(type || '').split(';')[0].trim().toLowerCase()];
  return extension ? `.${extension}` : '';
}

async function inspectUrl(input) {
  const url = validateUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let type = '';
    let disposition = '';
    let size = 0;
    let response = null;
    try {
      response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Meldrix/1.0' }
      });
      type = response.headers.get('content-type') || '';
      disposition = response.headers.get('content-disposition') || '';
      size = Number(response.headers.get('content-length') || 0);
    } catch {
      response = null;
    }

    if (!response || !response.ok || !type || !size) {
      try {
        const probe = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: { Range: 'bytes=0-0', 'User-Agent': 'Meldrix/1.0' }
        });
        type = type || probe.headers.get('content-type') || '';
        disposition = disposition || probe.headers.get('content-disposition') || '';
        const range = probe.headers.get('content-range') || '';
        const rangeMatch = /\/(\d+)\s*$/.exec(range);
        size = size || Number(probe.headers.get('content-length') || 0) || (rangeMatch ? Number(rangeMatch[1]) : 0);
        if (probe.body) await probe.body.cancel().catch(() => {});
      } catch {
        // HEAD metadata is enough when the range probe is not allowed.
      }
    }

    const suggested = dispositionFilename(disposition);
    let name = safeName(suggested || filenameFrom(url));
    name = safeName(name + extensionFor(name, type));
    return {
      name,
      mimeType: (type || '').split(';')[0].trim(),
      size: Number.isFinite(size) ? size : 0,
      category: categoryFor(name, type),
      kind: /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(type) ? 'hls' : 'file'
    };
  } finally {
    clearTimeout(timer);
  }
}

function enqueueInput(input, options = {}) {
  if (!input || typeof input !== 'object') throw new Error('Invalid download request');
  const url = validateUrl(input.url);
  if (/\.mpd(\?|$)/i.test(url)) throw new Error('DASH manifests require stream muxing and are not supported in this build');
  const existing = one('SELECT * FROM downloads WHERE url=? AND status NOT IN (?,?) ORDER BY created_at DESC', [url, 'completed', 'failed']);
  if (existing) return existing;

  const providedName = typeof input.name === 'string' && input.name.trim() ? input.name : filenameFrom(url);
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType : '';
  const name = safeName(providedName + extensionFor(providedName, mimeType));
  const destination = typeof input.destination === 'string' && input.destination.trim()
    ? input.destination
    : setting('default_download_directory', '') || app.getPath('downloads');
  const category = typeof input.category === 'string' && input.category ? input.category : categoryFor(name, mimeType);
  const referrer = validReferrer(input.referrer);
  const kind = input.kind === 'hls' || /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'file';
  const row = {
    id: crypto.randomUUID(),
    url,
    name,
    destination,
    category,
    kind,
    size: Number(input.size) || 0,
    downloaded: 0,
    status: 'queued',
    created_at: new Date().toISOString(),
    referrer,
    error: null
  };
  run(
    'INSERT INTO downloads (id,url,name,destination,category,kind,size,downloaded,status,created_at,referrer,error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [row.id, row.url, row.name, row.destination, row.category, row.kind, row.size, row.downloaded, row.status, row.created_at, row.referrer, row.error]
  );
  if (options.startNow) startDownload(row);
  return row;
}

function startDownload(row) {
  if (!row || active.has(row.id)) return;
  run('UPDATE downloads SET status=?,error=NULL WHERE id=?', ['downloading', row.id]);
  send('downloads:progress', { id: row.id, status: 'downloading', downloaded: Number(row.downloaded) || 0, size: Number(row.size) || 0, speed: 0 });
  download(row).catch(error => log.error('download-run-failed', error));
}

function hlsAttributes(value) {
  const attributes = {};
  const pattern = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = pattern.exec(value))) {
    attributes[match[1].toUpperCase()] = String(match[2]).replace(/^"|"$/g, '').trim();
  }
  return attributes;
}

async function fetchTextResource(url, referrer, signal, accept) {
  const headers = { 'User-Agent': 'Meldrix/1.0' };
  if (accept) headers.Accept = accept;
  if (validReferrer(referrer)) headers.Referer = referrer;
  const response = await fetch(url, { headers, signal, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} while reading the stream playlist`);
  const text = await response.text();
  return { text, finalUrl: response.url || url };
}

function selectHlsVariant(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let best = null;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attributes = hlsAttributes(lines[index].slice('#EXT-X-STREAM-INF:'.length));
    let next = index + 1;
    while (next < lines.length && lines[next].startsWith('#')) next++;
    if (!lines[next]) continue;
    const bandwidth = Number(attributes.BANDWIDTH || attributes['AVERAGE-BANDWIDTH'] || 0);
    if (!best || bandwidth > best.bandwidth) best = { url: new URL(lines[next], baseUrl).toString(), bandwidth };
  }
  return best ? best.url : '';
}

function parseHlsMedia(text, baseUrl) {
  if (/#EXT-X-(?:SESSION-)?KEY:[^\r\n]*METHOD=(?!NONE\b)/i.test(text)) throw new Error('Encrypted HLS streams are not supported');
  if (!/#EXT-X-ENDLIST/i.test(text) && !/#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(text)) throw new Error('Live HLS streams are not supported');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const segments = [];
  let mapUrl = '';
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = hlsAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attributes.URI) mapUrl = new URL(attributes.URI, baseUrl).toString();
    } else if (!line.startsWith('#')) {
      segments.push(new URL(line, baseUrl).toString());
    }
  }
  const container = mapUrl || segments.some(url => /\.(m4s|mp4)(\?|$)/i.test(url)) ? 'mp4' : 'ts';
  return { segments: mapUrl ? [mapUrl, ...segments] : segments, container };
}

async function downloadHls(row, controller, target, temp) {
  let playlist = await fetchTextResource(row.url, row.referrer, controller.signal, 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*');
  if (/#EXT-X-(?:SESSION-)?KEY:[^\r\n]*METHOD=(?!NONE\b)/i.test(playlist.text)) throw new Error('Encrypted HLS streams are not supported');
  if (/#EXT-X-STREAM-INF:/i.test(playlist.text)) {
    const variant = selectHlsVariant(playlist.text, playlist.finalUrl);
    if (!variant) throw new Error('The HLS master playlist has no playable variants');
    playlist = await fetchTextResource(variant, row.referrer, controller.signal, 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*');
  }
  const media = parseHlsMedia(playlist.text, playlist.finalUrl);
  if (!media.segments.length) throw new Error('The HLS playlist contains no segments');
  let finalTarget = target;
  if (media.container === 'ts' && /\.mp4$/i.test(finalTarget)) finalTarget = finalTarget.replace(/\.mp4$/i, '.ts');
  if (media.container === 'mp4' && /\.ts$/i.test(finalTarget)) finalTarget = finalTarget.replace(/\.ts$/i, '.mp4');
  const finalName = safeName(path.basename(finalTarget));
  const finalTemp = `${finalTarget}.meldrix.part`;
  const stream = await fs.promises.open(finalTemp, 'w');
  let done = 0;
  let last = Date.now();
  let lastBytes = 0;
  try {
    for (let index = 0; index < media.segments.length; index++) {
      if (controller.signal.aborted) {
        const error = new Error('Paused');
        error.name = 'AbortError';
        throw error;
      }
      let response = null;
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const headers = { 'User-Agent': 'Meldrix/1.0' };
          if (validReferrer(row.referrer)) headers.Referer = row.referrer;
          response = await fetch(media.segments[index], { headers, signal: controller.signal, redirect: 'follow' });
          if (response.ok) break;
          lastError = new Error(`HLS segment ${index + 1} returned HTTP ${response.status}`);
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          lastError = error;
        }
      }
      if (!response || !response.ok) throw lastError || new Error(`Could not download HLS segment ${index + 1}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await stream.write(buffer);
      done += buffer.length;
      const now = Date.now();
      if (now - last > 350) {
        const speed = Math.round((done - lastBytes) * 1000 / (now - last));
        run('UPDATE downloads SET downloaded=?,status=? WHERE id=?', [done, 'downloading', row.id]);
        send('downloads:progress', { id: row.id, downloaded: done, size: 0, speed, status: 'downloading' });
        last = now;
        lastBytes = done;
      }
    }
  } catch (error) {
    await stream.close().catch(() => {});
    fs.rmSync(finalTemp, { force: true });
    throw error;
  }
  await stream.close();
  fs.renameSync(finalTemp, finalTarget);
  run('UPDATE downloads SET name=?,downloaded=?,size=?,status=?,error=NULL WHERE id=?', [finalName, done, done, 'completed', row.id]);
  send('downloads:progress', { id: row.id, name: finalName, downloaded: done, size: done, speed: 0, status: 'completed' });
  notify('Download complete', finalName);
  pumpQueue();
}

async function download(row) {
  const controller = new AbortController();
  active.set(row.id, controller);
  const target = path.join(row.destination, safeName(row.name));
  const temp = `${target}.meldrix.part`;
  try {
    fs.mkdirSync(row.destination, { recursive: true });
    if (row.kind === 'hls' || /\.m3u8(\?|$)/i.test(row.url)) {
      await downloadHls(row, controller, target, temp);
      return;
    }
    let start = 0;
    try {
      if (fs.existsSync(temp)) start = fs.statSync(temp).size;
    } catch {
      start = 0;
    }
    const headers = { 'User-Agent': 'Meldrix/1.0' };
    if (start) headers.Range = `bytes=${start}-`;
    if (validReferrer(row.referrer)) headers.Referer = row.referrer;
    const response = await fetch(row.url, { headers, signal: controller.signal });
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
    if (start > 0 && response.status !== 206) start = 0;
    const total = Number(response.headers.get('content-length') || 0) + (response.status === 206 ? start : 0);
    const stream = require('stream').Readable.fromWeb(response.body);
    let done = start;
    let last = Date.now();
    let lastBytes = done;
    stream.on('data', chunk => {
      done += chunk.length;
      const now = Date.now();
      if (now - last > 250) {
        const speed = Math.round((done - lastBytes) * 1000 / (now - last));
        run('UPDATE downloads SET downloaded=?,size=?,status=? WHERE id=?', [done, total || done, 'downloading', row.id]);
        send('downloads:progress', { id: row.id, downloaded: done, size: total || done, speed, status: 'downloading' });
        last = now;
        lastBytes = done;
      }
    });
    await pipeline(stream, fs.createWriteStream(temp, { flags: start ? 'a' : 'w' }));
    fs.renameSync(temp, target);
    run('UPDATE downloads SET downloaded=?,size=?,status=?,error=NULL WHERE id=?', [total || done, total || done, 'completed', row.id]);
    send('downloads:progress', { id: row.id, downloaded: total || done, size: total || done, speed: 0, status: 'completed' });
    notify('Download complete', row.name);
    pumpQueue();
  } catch (error) {
    if (error.name === 'AbortError') {
      let pausedAt = 0;
      if (row.kind !== 'hls') {
        try { pausedAt = fs.existsSync(temp) ? fs.statSync(temp).size : Number(row.downloaded) || 0; }
        catch { pausedAt = Number(row.downloaded) || 0; }
      }
      run('UPDATE downloads SET status=?,downloaded=? WHERE id=?', ['paused', pausedAt, row.id]);
      send('downloads:progress', { id: row.id, downloaded: pausedAt, status: 'paused' });
    } else {
      log.error('download-failed', error);
      run('UPDATE downloads SET status=?,error=? WHERE id=?', ['failed', String(error.message || error), row.id]);
      send('downloads:progress', { id: row.id, status: 'failed', error: String(error.message || error) });
    }
  } finally {
    active.delete(row.id);
    if (pendingResumes.delete(row.id)) {
      const current = one('SELECT * FROM downloads WHERE id=?', [row.id]);
      if (current && current.status === 'paused') startDownload(current);
    }
  }
}

let queueRunning = false;

function pumpQueue() {
  if (!queueRunning) return;
  const queued = all("SELECT * FROM downloads WHERE status='queued' ORDER BY created_at ASC");
  for (const row of queued) {
    if (active.size >= 3) break;
    startDownload(row);
  }
}

function startQueue() {
  queueRunning = true;
  pumpQueue();
}

function stopQueue() {
  queueRunning = false;
  active.forEach(controller => controller.abort());
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function send(channel, value) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function focusWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (app.focus) app.focus();
}

function sendInspectRequest(payload) {
  latestReview = payload;
  focusWindow();
  const deliver = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('downloads:inspect-request', payload);
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', deliver);
  else deliver();
}

function prepareNativeHost() {
  const source = app.isPackaged
    ? path.join(process.resourcesPath, 'native-host', 'MeldrixNativeHost.exe')
    : path.join(app.getAppPath(), 'native-host', 'MeldrixNativeHost.exe');
  const directory = path.join(dataDir(), 'native-host');
  if (!fs.existsSync(source)) return source;
  try {
    fs.mkdirSync(directory, { recursive: true });
    if (app.isPackaged) fs.writeFileSync(path.join(directory, 'app-path.txt'), process.execPath, 'utf8');
  } catch (error) {
    log.error('native-host-preparation-failed', error);
  }
  try {
    // Native hosts can stay alive for the full lifetime of a browser port, and
    // Windows locks a running executable against replacement. Use immutable,
    // content-addressed copies and atomically point the manifest at the new
    // binary instead of trying to overwrite a locked stable filename.
    const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 16);
    const target = path.join(directory, `MeldrixNativeHost-${digest}.exe`);
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    const writtenDigest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex').slice(0, 16);
    if (writtenDigest !== digest) throw new Error('Copied native host hash does not match packaged host');
    fs.writeFileSync(path.join(directory, 'host-path.txt'), target, 'utf8');
    return target;
  } catch (error) {
    log.error('native-host-copy-failed', error);
    return source;
  }
}

function nativeHostPath() {
  const directory = path.join(dataDir(), 'native-host');
  try {
    const active = fs.readFileSync(path.join(directory, 'host-path.txt'), 'utf8').trim();
    if (active && fs.existsSync(active)) return active;
  } catch {
    // Fall back to the pre-v2 stable path when upgrading an existing install.
  }
  const stable = path.join(directory, 'MeldrixNativeHost.exe');
  if (fs.existsSync(stable)) return stable;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native-host', 'MeldrixNativeHost.exe')
    : path.join(app.getAppPath(), 'native-host', 'MeldrixNativeHost.exe');
}

function registryValue(key) {
  try {
    const output = execFileSync('reg.exe', ['QUERY', key, '/ve'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const line = output.split(/\r?\n/).find(value => /REG_SZ/.test(value));
    return line ? line.replace(/^.*REG_SZ\s+/, '').trim() : '';
  } catch {
    return '';
  }
}

function browserInstalled(browser) {
  const folders = [];
  if (browser === 'chrome') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) folders.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    if (folders.some(file => fs.existsSync(file))) return true;
    return !!registryValue('HKCU\\Software\\Google\\Chrome\\BLBeacon');
  }
  for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
    if (base) folders.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (folders.some(file => fs.existsSync(file))) return true;
  return !!registryValue('HKCU\\Software\\Microsoft\\Edge\\BLBeacon');
}

function integrationStatus() {
  const manifestPath = path.join(dataDir(), `${HOST_NAME}.json`);
  let manifestValid = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifestValid = manifest && manifest.name === HOST_NAME && typeof manifest.path === 'string';
  } catch {
    manifestValid = false;
  }
  const hostPath = nativeHostPath();
  const chromeKey = REGISTRY_KEYS[0];
  const edgeKey = REGISTRY_KEYS[1];
  const chromeRegistry = registryValue(chromeKey);
  const edgeRegistry = registryValue(edgeKey);
  const recentlySeen = Date.now() - lastNativeAt < 30000;
  return {
    connected: nativeConnections.size > 0 || recentlySeen,
    ready: !!nativeReadyAt,
    lastNativeAt: lastNativeAt ? new Date(lastNativeAt).toISOString() : null,
    version: app.getVersion(),
    protocolVersion: PROTOCOL_VERSION,
    hostPath,
    hostExists: fs.existsSync(hostPath),
    manifestPath,
    manifestExists: fs.existsSync(manifestPath),
    manifestValid,
    chrome: {
      installed: browserInstalled('chrome'),
      registered: !!chromeRegistry && fs.existsSync(chromeRegistry),
      connected: Date.now() - lastBrowserAt.chrome < 30000,
      registryPath: chromeRegistry
    },
    edge: {
      installed: browserInstalled('edge'),
      registered: !!edgeRegistry && fs.existsSync(edgeRegistry),
      connected: Date.now() - lastBrowserAt.edge < 30000,
      registryPath: edgeRegistry
    },
    settings: extensionSettings()
  };
}

function broadcastIntegration() {
  if (integrationTimer) clearTimeout(integrationTimer);
  integrationTimer = setTimeout(() => {
    integrationTimer = null;
    send('integration:changed', integrationStatus());
  }, 150);
}

function registerNativeMessaging() {
  if (process.platform !== 'win32') return;
  const hostPath = nativeHostPath();
  const manifestPath = path.join(dataDir(), `${HOST_NAME}.json`);
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: HOST_NAME,
      description: 'Meldrix Download Manager native messaging host',
      path: hostPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    }, null, 2));
  } catch (error) {
    log.error('native-manifest-write-failed', error);
    return;
  }
  for (const key of REGISTRY_KEYS) {
    try {
      execFileSync('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      log.error('native-registry-failed', { key, error: error.message });
    }
  }
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rememberNative(requestId, response) {
  if (!requestId) return response;
  recentNative.set(requestId, { at: Date.now(), response });
  for (const [key, entry] of recentNative) {
    if (Date.now() - entry.at > 120000) recentNative.delete(key);
  }
  while (recentNative.size > 200) recentNative.delete(recentNative.keys().next().value);
  return response;
}

function clearReviewFor(url) {
  pendingReviews.delete(url);
  if (latestReview && latestReview.url === url) latestReview = null;
}

function updateExtensionSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw bridgeError('INVALID_SETTINGS', 'Invalid settings');
  for (const key of Object.keys(values)) {
    if (!['intercept', 'overlay', 'confirmBeforeDownload'].includes(key)) throw bridgeError('INVALID_SETTINGS', `Unknown setting: ${key}`);
    if (typeof values[key] !== 'boolean') throw bridgeError('INVALID_SETTINGS', `Setting ${key} must be a boolean`);
  }
  if (typeof values.intercept === 'boolean') saveSetting('auto_detect_downloads', values.intercept ? '1' : '0');
  if (typeof values.overlay === 'boolean') saveSetting('show_video_button', values.overlay ? '1' : '0');
  if (typeof values.confirmBeforeDownload === 'boolean') saveSetting('confirm_before_download', values.confirmBeforeDownload ? '1' : '0');
  broadcastIntegration();
  return { version: PROTOCOL_VERSION, type: 'settings', app: 'meldrix', hostVersion: NATIVE_HOST_VERSION, settings: extensionSettings() };
}

async function nativeEnqueue(message) {
  const url = validateUrl(message.url);
  const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 128) : '';
  if (requestId) {
    const cached = recentNative.get(requestId);
    if (cached && Date.now() - cached.at < 120000) {
      const pending = pendingReviews.get(url);
      if (pending && cached.response && cached.response.status === 'review') {
        focusWindow();
        sendInspectRequest(pending.request);
      } else {
        focusWindow();
      }
      return { ...cached.response, duplicate: true };
    }
  }

  const existing = one('SELECT * FROM downloads WHERE url=? AND status NOT IN (?,?) ORDER BY created_at DESC', [url, 'completed', 'failed']);
  if (existing) {
    focusWindow();
    const response = { version: PROTOCOL_VERSION, type: 'accepted', app: 'meldrix', id: existing.id, status: existing.status, duplicate: true, desktopReady: true };
    return rememberNative(requestId, response);
  }

  const now = Date.now();
  for (const [key, entry] of pendingReviews) {
    if (now - entry.at > 120000) pendingReviews.delete(key);
  }
  const pending = pendingReviews.get(url);
  if (pending) {
    focusWindow();
    sendInspectRequest(pending.request);
    const response = { version: PROTOCOL_VERSION, type: 'accepted', app: 'meldrix', id: pending.request.id, status: 'review', duplicate: true, desktopReady: true };
    return rememberNative(requestId, response);
  }

  const name = safeName(message.name || filenameFrom(url));
  const mimeType = typeof message.mimeType === 'string' ? message.mimeType.slice(0, 200) : '';
  const quality = typeof message.quality === 'string' ? message.quality.slice(0, 200) : '';
  const request = {
    id: crypto.randomUUID(),
    requestId,
    url,
    name,
    mimeType,
    quality,
    kind: message.kind === 'hls' || /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'file',
    size: Number.isFinite(Number(message.size)) ? Math.max(0, Number(message.size)) : 0,
    category: categoryFor(name, mimeType),
    referrer: validReferrer(message.referrer),
    source: typeof message.source === 'string' ? message.source.slice(0, 40) : 'browser',
    at: now
  };

  if (setting('confirm_before_download', '1') !== '1') {
    const row = enqueueInput(request, { startNow: true });
    clearReviewFor(url);
    focusWindow();
    send('downloads:added', row);
    broadcastIntegration();
    const response = { version: PROTOCOL_VERSION, type: 'accepted', app: 'meldrix', id: row.id, status: row.status, desktopReady: true };
    return rememberNative(requestId, response);
  }

  pendingReviews.set(url, { at: now, request });
  sendInspectRequest(request);
  broadcastIntegration();
  const response = { version: PROTOCOL_VERSION, type: 'accepted', app: 'meldrix', id: request.id, status: 'review', desktopReady: true };
  return rememberNative(requestId, response);
}

function validateNativeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw bridgeError('INVALID_MESSAGE', 'Invalid message');
  if (message.version !== PROTOCOL_VERSION) throw bridgeError('UNSUPPORTED_VERSION', 'The browser extension and desktop app versions do not match');
  if (typeof message.type !== 'string') throw bridgeError('UNSUPPORTED_TYPE', 'Missing operation');
  if (!['hello', 'ping', 'enqueue', 'show', 'settings:update'].includes(message.type)) {
    throw bridgeError('UNSUPPORTED_TYPE', `Unsupported operation: ${message.type}`);
  }
  if (message.type === 'enqueue') {
    if (typeof message.url !== 'string' || message.url.length > 4096) throw bridgeError('INVALID_URL', 'Invalid download URL');
    if (message.requestId != null && (typeof message.requestId !== 'string' || message.requestId.length > 128)) {
      throw bridgeError('INVALID_REQUEST', 'Invalid request id');
    }
  }
  if (message.type === 'settings:update' && (!message.settings || typeof message.settings !== 'object' || Array.isArray(message.settings))) {
    throw bridgeError('INVALID_SETTINGS', 'Invalid settings');
  }
}

async function handleNativeMessage(message) {
  validateNativeMessage(message);
  lastNativeAt = Date.now();
  if (message.browser === 'chrome' || message.browser === 'edge') lastBrowserAt[message.browser] = lastNativeAt;
  broadcastIntegration();

  if (message.type === 'hello') {
    return {
      version: PROTOCOL_VERSION,
      type: 'ready',
      app: 'meldrix',
      appVersion: app.getVersion(),
      hostVersion: NATIVE_HOST_VERSION,
      desktopReady: true,
      readyAt: new Date(nativeReadyAt || lastNativeAt).toISOString(),
      capabilities: ['review', 'hls', 'dedupe', 'launch', 'settings'],
      settings: extensionSettings()
    };
  }
  if (message.type === 'ping') {
    return {
      version: PROTOCOL_VERSION,
      type: 'pong',
      app: 'meldrix',
      appVersion: app.getVersion(),
      hostVersion: NATIVE_HOST_VERSION,
      desktopReady: true,
      readyAt: new Date(nativeReadyAt || lastNativeAt).toISOString(),
      capabilities: ['review', 'hls', 'dedupe', 'launch', 'settings'],
      settings: extensionSettings()
    };
  }
  if (message.type === 'show') {
    focusWindow();
    return { version: PROTOCOL_VERSION, type: 'shown', app: 'meldrix', hostVersion: NATIVE_HOST_VERSION, desktopReady: true };
  }
  if (message.type === 'enqueue') return nativeEnqueue(message);
  if (message.type === 'settings:update') return updateExtensionSettings(message.settings);
  throw bridgeError('UNSUPPORTED_TYPE', 'Unsupported operation');
}

function applyLoginItem(enabled) {
  if (!app.isPackaged) return;
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    ...(portable ? { path: portable } : {})
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#f8f9fc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const contents = win.webContents;
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => log.error('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame }));
  contents.on('render-process-gone', (_event, details) => log.error('render-process-gone', details));
  contents.on('preload-error', (_event, preloadPath, error) => log.error('preload-error', { preloadPath, error }));
  contents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) log.warn('renderer-console', { level, message, line, sourceId });
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', event => {
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  const dev = process.argv.includes('--dev') || process.env.VITE_DEV_SERVER_URL;
  if (dev) {
    log.info('Loading development renderer');
    win.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
  } else {
    const productionHtml = path.join(app.getAppPath(), 'dist', 'index.html');
    log.info('Loading packaged renderer', productionHtml);
    win.loadFile(productionHtml);
  }
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Meldrix Download Manager');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Meldrix', click: () => focusWindow() },
    { label: 'Start queue', click: () => startQueue() },
    { label: 'Pause all downloads', click: () => stopQueue() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => focusWindow());
}

function createNativePipe() {
  pipeServer = net.createServer(socket => {
    nativeConnections.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', error => log.warn('native-pipe-socket', error.message));
    socket.on('close', () => {
      nativeConnections.delete(socket);
      broadcastIntegration();
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const respond = value => {
          try { socket.write(`${JSON.stringify({ ...value, version: PROTOCOL_VERSION, ok: value && value.type !== 'error' })}\n`); } catch { /* client disconnected */ }
        };
        let message;
        try {
          message = JSON.parse(raw);
          handleNativeMessage(message)
            .then(response => respond(response))
            .catch(error => respond({ type: 'error', code: error.code || 'DESKTOP_ERROR', error: error.message || 'Request failed', id: message && message.id }));
        } catch {
          respond({ type: 'error', code: 'INVALID_JSON', error: 'Invalid JSON' });
        }
      }
    });
  });
  pipeServer.on('error', error => log.error('native-pipe-error', error));
  pipeServer.listen(PIPE_NAME, () => {
    nativeReadyAt = Date.now();
    broadcastIntegration();
    log.info('Native Messaging pipe ready');
  });
  return pipeServer;
}

async function initDb() {
  fs.mkdirSync(dataDir(), { recursive: true });
  SQL = await initSqlJs({ locateFile: file => path.join(__dirname, '../node_modules/sql.js/dist', file) });
  const file = path.join(dataDir(), 'meldrix.sqlite');
  db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
  db.run('CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY,url TEXT NOT NULL,name TEXT NOT NULL,destination TEXT NOT NULL,category TEXT DEFAULT \'All files\',kind TEXT DEFAULT \'file\',size INTEGER DEFAULT 0,downloaded INTEGER DEFAULT 0,status TEXT NOT NULL,created_at TEXT NOT NULL,referrer TEXT DEFAULT \'\',error TEXT)');
  try { db.run("ALTER TABLE downloads ADD COLUMN category TEXT DEFAULT 'All files'"); } catch { /* already present */ }
  try { db.run("ALTER TABLE downloads ADD COLUMN referrer TEXT DEFAULT ''"); } catch { /* already present */ }
  try { db.run("ALTER TABLE downloads ADD COLUMN kind TEXT DEFAULT 'file'"); } catch { /* already present */ }
  db.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!key || key === 'default_download_directory') continue;
    db.run('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)', [key, value]);
  }
  saveDb();
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('downloads:list', () => all('SELECT * FROM downloads ORDER BY created_at DESC').map(row => ({
  ...row,
  category: row.category || categoryFor(row.name)
})));

ipcMain.handle('downloads:inspect', (_event, input) => inspectUrl(input));

ipcMain.handle('downloads:add', (_event, input) => {
  const startNow = !input || input.startNow !== false;
  const row = enqueueInput(input, { startNow });
  if (row && row.url) clearReviewFor(row.url);
  return row;
});

ipcMain.handle('downloads:pause', (_event, id) => {
  if (typeof id !== 'string' || !one('SELECT id FROM downloads WHERE id=?', [id])) throw new Error('Download task not found');
  active.get(id)?.abort();
  run('UPDATE downloads SET status=? WHERE id=?', ['paused', id]);
  send('downloads:progress', { id, status: 'paused' });
  return { ok: true, id, status: 'paused' };
});

ipcMain.handle('downloads:resume', (_event, id) => {
  if (typeof id !== 'string') throw new Error('Invalid download task id');
  const row = one('SELECT * FROM downloads WHERE id=?', [id]);
  if (!row) throw new Error('Download task not found');
  if (!['paused', 'queued'].includes(row.status)) throw new Error(`Cannot resume a ${row.status} task`);
  const controller = active.get(id);
  if (controller) {
    if (controller.signal.aborted) {
      pendingResumes.add(id);
      return { ok: true, id, status: 'resuming' };
    }
    throw new Error('Download task is already running');
  }
  startDownload(row);
  return { ok: true, id, status: 'downloading' };
});

ipcMain.handle('downloads:cancel', (_event, id) => {
  if (typeof id !== 'string' || !one('SELECT id FROM downloads WHERE id=?', [id])) throw new Error('Download task not found');
  active.get(id)?.abort();
  pendingResumes.delete(id);
  run('DELETE FROM downloads WHERE id=?', [id]);
  if (latestReview && latestReview.id === id) latestReview = null;
  return { ok: true, id };
});

ipcMain.handle('downloads:delete-many', async (_event, ids) => {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'string' || id.length > 128)) {
    throw new Error('Select one or more valid download tasks');
  }
  const uniqueIds = [...new Set(ids)];
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = all(`SELECT id,name FROM downloads WHERE id IN (${placeholders})`, uniqueIds);
  if (!rows.length) return { ok: true, deleted: 0 };
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete tasks', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete download tasks',
    message: `Remove ${rows.length} selected task${rows.length === 1 ? '' : 's'} from Meldrix?`,
    detail: 'This removes task records only. Completed files and partial download files are left on disk.'
  });
  if (result.response !== 0) return { ok: false, deleted: 0, canceled: true };
  const existingIds = rows.map(row => row.id);
  for (const id of existingIds) active.get(id)?.abort();
  existingIds.forEach(id => pendingResumes.delete(id));
  db.run(`DELETE FROM downloads WHERE id IN (${existingIds.map(() => '?').join(',')})`, existingIds);
  saveDb();
  for (const id of existingIds) {
    if (latestReview && latestReview.id === id) latestReview = null;
    for (const [url, entry] of pendingReviews) if (entry.request.id === id) pendingReviews.delete(url);
  }
  send('downloads:removed', existingIds);
  return { ok: true, deleted: existingIds.length };
});

ipcMain.handle('downloads:open-file', async (_event, id) => {
  if (typeof id !== 'string') throw new Error('Invalid download task id');
  const row = one('SELECT * FROM downloads WHERE id=?', [id]);
  if (!row) throw new Error('Download task not found');
  if (row.status !== 'completed') throw new Error('Only completed downloads can be opened as files');
  const destination = path.resolve(String(row.destination || ''));
  const target = path.resolve(destination, safeName(row.name));
  if (!target.startsWith(`${destination}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error('The downloaded file is missing from its saved location');
  }
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { ok: true };
});

ipcMain.handle('downloads:open-task-folder', async (_event, id) => {
  if (typeof id !== 'string') throw new Error('Invalid download task id');
  const row = one('SELECT destination FROM downloads WHERE id=?', [id]);
  if (!row) throw new Error('Download task not found');
  const folder = path.resolve(String(row.destination || ''));
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('The task folder does not exist');
  const error = await shell.openPath(folder);
  if (error) throw new Error(error);
  return { ok: true };
});

ipcMain.handle('downloads:start-queue', () => { startQueue(); return true; });
ipcMain.handle('downloads:stop-queue', () => { stopQueue(); return true; });

ipcMain.handle('downloads:open-folder', async () => {
  const error = await shell.openPath(setting('default_download_directory', '') || app.getPath('downloads'));
  if (error) throw new Error(error);
  return { ok: true };
});

ipcMain.handle('downloads:pending-review', () => latestReview);

ipcMain.handle('downloads:dismiss-review', (_event, id) => {
  if (latestReview && (!id || latestReview.id === id)) latestReview = null;
  for (const [url, entry] of pendingReviews) {
    if (!id || entry.request.id === id) pendingReviews.delete(url);
  }
  return true;
});

ipcMain.handle('browser:open-external', (_event, input) => {
  const parsed = new URL(input);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only web links can be opened');
  return shell.openExternal(parsed.toString());
});

ipcMain.handle('browser:open-extension-folder', async () => {
  const folder = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(app.getAppPath(), 'extension');
  const error = await shell.openPath(folder);
  if (error) throw new Error(error);
  return { ok: true };
});

ipcMain.handle('help:open-readme', async () => {
  const readme = app.isPackaged
    ? path.join(process.resourcesPath, 'README.md')
    : path.join(app.getAppPath(), 'README.md');
  if (!fs.existsSync(readme)) throw new Error('The bundled README is not available');
  const error = await shell.openPath(readme);
  if (error) throw new Error(error);
  return { ok: true };
});

ipcMain.handle('help:about', async () => {
  await dialog.showMessageBox(win, {
    type: 'info',
    title: 'About Meldrix Download Manager',
    message: 'Meldrix Download Manager',
    detail: `Version ${app.getVersion()}\nDownload manager for Windows.\n\nhttps://github.com/fahadmia20333/download-manager`
  });
  return { ok: true };
});

ipcMain.handle('help:updates-info', async () => {
  await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Check for Updates',
    message: 'Automatic updates are not configured',
    detail: 'Meldrix does not currently have an in-app update service. Check the GitHub repository for project information.'
  });
  return { ok: true, configured: false };
});

ipcMain.handle('browser:integration-status', () => integrationStatus());

ipcMain.handle('settings:get', (_event, key) => {
  const row = one('SELECT value FROM settings WHERE key=?', [key]);
  if (row) return row.value;
  return key === 'default_download_directory' ? app.getPath('downloads') : '';
});

ipcMain.handle('settings:set', (_event, key, value) => {
  if (typeof key !== 'string' || typeof value !== 'string') throw new Error('Invalid setting');
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) throw new Error('Unknown setting');
  saveSetting(key, value);
  if (key === 'start_with_windows' && app.isPackaged) {
    applyLoginItem(value === '1');
  }
  broadcastIntegration();
  return value;
});

ipcMain.handle('dialog:select-folder', async () => {
  const current = setting('default_download_directory', '') || app.getPath('downloads');
  const result = await dialog.showOpenDialog(win, { title: 'Choose download folder', defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0] || null;
});

app.on('second-instance', () => focusWindow());

app.whenReady().then(async () => {
  log.transports.file.resolvePathFn = () => path.join(app.getPath('logs'), 'main.log');
  log.info('Meldrix starting', { version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath() });
  app.setAppUserModelId('com.meldrix.downloadmanager');
  const startupDelay = Number(process.env.MELDRIX_START_DELAY_MS || 0);
  if (Number.isFinite(startupDelay) && startupDelay > 0) {
    log.info('MELDRIX_START_DELAY_MS active', { startupDelay });
    await new Promise(resolve => setTimeout(resolve, Math.min(startupDelay, 25000)));
  }
  try {
    await initDb();
  } catch (error) {
    log.error('database-init-failed', error);
  }
  if (app.isPackaged) {
    applyLoginItem(setting('start_with_windows', '1') === '1');
  }
  prepareNativeHost();
  registerNativeMessaging();
  createWindow();
  createTray();
  createNativePipe();
}).catch(error => log.error('startup-failed', error));

app.on('before-quit', () => {
  app.isQuitting = true;
  active.forEach(controller => controller.abort());
  if (pipeServer) {
    try { pipeServer.close(); } catch { /* already closed */ }
  }
});
