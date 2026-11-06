// Meldrix Native Messaging host (bridge protocol v2).
//
// Transport
//   browser <-> this host : Chrome Native Messaging (4-byte LE length + UTF-8 JSON)
//   this host <-> desktop : Windows named pipe \\.\pipe\meldrix-download-manager
//                           (newline-delimited JSON)
//
// Every response is correlated by id, carries the protocol version, and has an
// explicit ok flag plus a machine readable code. When the desktop app is not
// running this host launches it through the registered app path and waits for
// the desktop pipe to accept a request. Retries are bounded by a single total
// budget so a broken install fails quickly instead of spinning forever.
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const VERSION = 2;
const HOST_NAME = 'meldrix-native';
const HOST_VERSION = '2.0.0';
const MAX_MESSAGE = 2 * 1024 * 1024;
const PIPE = '\\\\.\\pipe\\meldrix-download-manager';
const CONNECT_TIMEOUT = 2500;
const REQUEST_BUDGET = 20000;
const LAUNCH_COOLDOWN = 5000;
const ALLOWED_TYPES = new Set(['hello', 'ping', 'enqueue', 'show', 'settings:update']);

let buffer = Buffer.alloc(0);
let lastLaunchAt = 0;

function write(value) {
  try {
    const body = Buffer.from(JSON.stringify(value));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([head, body]));
  } catch {
    // stdout is protocol-only; diagnostics go to stderr.
  }
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function respond(value, id) {
  const payload = {
    ...value,
    version: VERSION,
    ok: value && value.type !== 'error',
    app: value && value.app ? value.app : 'meldrix',
    host: HOST_NAME,
    hostVersion: HOST_VERSION
  };
  if (id !== undefined && id !== null) payload.id = id;
  write(payload);
}

function appCandidates() {
  const here = path.dirname(process.execPath);
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  let recorded = '';
  try {
    recorded = fs.readFileSync(path.join(here, 'app-path.txt'), 'utf8').trim().split(/\r?\n/)[0];
  } catch {
    // No recorded path; fall back to standard install locations.
  }
  return [
    process.env.MELDRIX_APP_EXE,
    recorded,
    path.join(here, '..', '..', 'Meldrix Download Manager.exe'),
    path.join(here, '..', 'Meldrix Download Manager.exe'),
    local ? path.join(local, 'Programs', 'Meldrix Download Manager', 'Meldrix Download Manager.exe') : null,
    path.join(programFiles, 'Meldrix Download Manager', 'Meldrix Download Manager.exe')
  ].filter(Boolean);
}

function launchDesktop() {
  if (Date.now() - lastLaunchAt < LAUNCH_COOLDOWN) return true;
  for (const exe of [...new Set(appCandidates())]) {
    if (!fs.existsSync(exe)) continue;
    try {
      const child = spawn(exe, ['--meldrix-native-launch'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', () => {});
      child.unref();
      lastLaunchAt = Date.now();
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

function retryDelay(attempt) {
  return Math.min(2500, Math.round(220 * Math.pow(1.35, attempt)) + Math.floor(Math.random() * 120));
}

function readResponse(socket, resolve, reject, finish) {
  let data = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    data += chunk;
    if (data.length > MAX_MESSAGE) {
      finish(reject, bridgeError('INVALID_RESPONSE', 'Meldrix returned an oversized response'));
      return;
    }
    const newline = data.indexOf('\n');
    if (newline === -1) return;
    let parsed;
    try {
      parsed = JSON.parse(data.slice(0, newline));
    } catch {
      finish(reject, bridgeError('INVALID_RESPONSE', 'Meldrix returned an invalid response'));
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      finish(reject, bridgeError('INVALID_RESPONSE', 'Meldrix returned an invalid response'));
      return;
    }
    if (typeof parsed.type !== 'string' || typeof parsed.ok !== 'boolean') {
      finish(reject, bridgeError('INVALID_RESPONSE', 'Meldrix returned an incomplete response'));
      return;
    }
    if (parsed.version !== VERSION) {
      finish(reject, bridgeError('UNSUPPORTED_VERSION', 'The Meldrix desktop app uses a different bridge protocol version'));
      return;
    }
    finish(resolve, parsed);
  });
}

function pipeRequest(message, startedAt = Date.now(), attempt = 0) {
  return new Promise((resolve, reject) => {
    if (Date.now() - startedAt > REQUEST_BUDGET) {
      reject(bridgeError('DESKTOP_TIMEOUT', 'Meldrix did not become ready in time'));
      return;
    }
    const socket = net.connect(PIPE);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      fn(value);
    };

    socket.setTimeout(CONNECT_TIMEOUT);
    socket.on('connect', () => {
      const remaining = Math.max(2500, REQUEST_BUDGET - (Date.now() - startedAt));
      socket.setTimeout(Math.min(remaining, 8000));
      try { socket.write(`${JSON.stringify(message)}\n`); }
      catch (error) { finish(reject, bridgeError('PIPE_ERROR', error.message)); }
    });
    readResponse(socket, resolve, reject, finish);
    socket.on('timeout', () => finish(reject, bridgeError('DESKTOP_TIMEOUT', 'Meldrix did not respond in time')));

    socket.on('error', error => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }

      const transient = ['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(error.code);
      if (!transient) {
        reject(bridgeError('PIPE_ERROR', error.code === 'EACCES'
          ? 'Access to the Meldrix desktop pipe was denied'
          : 'Meldrix connection failed'));
        return;
      }

      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        if (!launchDesktop()) {
          reject(bridgeError('LAUNCH_FAILED', 'Meldrix desktop app could not be started'));
          return;
        }
      }

      if (Date.now() - startedAt >= REQUEST_BUDGET) {
        reject(bridgeError('DESKTOP_TIMEOUT', 'Meldrix did not become ready in time'));
        return;
      }
      setTimeout(() => {
        pipeRequest(message, startedAt, attempt + 1).then(resolve, reject);
      }, retryDelay(attempt));
    });
  });
}

function normalizeId(value) {
  if (typeof value === 'string' && value.length && value.length <= 128) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function validateEnqueue(message) {
  if (typeof message.url !== 'string') return bridgeError('INVALID_URL', 'A download URL is required');
  if (message.url.length > 4096) return bridgeError('INVALID_URL', 'URL is too long');
  let parsed;
  try {
    parsed = new URL(message.url);
  } catch {
    return bridgeError('INVALID_URL', 'Invalid download URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return bridgeError('INVALID_URL', 'Only HTTP and HTTPS links are supported');
  if (parsed.username || parsed.password) return bridgeError('INVALID_URL', 'URLs with embedded credentials are not supported');
  if (message.name != null && (typeof message.name !== 'string' || message.name.length > 300)) {
    return bridgeError('INVALID_REQUEST', 'Invalid file name');
  }
  if (message.mimeType != null && (typeof message.mimeType !== 'string' || message.mimeType.length > 200)) {
    return bridgeError('INVALID_REQUEST', 'Invalid MIME type');
  }
  if (message.kind != null && !['file', 'hls'].includes(message.kind)) {
    return bridgeError('INVALID_REQUEST', 'Unsupported download kind');
  }
  if (message.size != null && (!Number.isFinite(Number(message.size)) || Number(message.size) < 0)) {
    return bridgeError('INVALID_REQUEST', 'Invalid size');
  }
  if (message.referrer != null && typeof message.referrer !== 'string') {
    return bridgeError('INVALID_REQUEST', 'Invalid referrer');
  }
  if (message.requestId != null && (typeof message.requestId !== 'string' || message.requestId.length > 128)) {
    return bridgeError('INVALID_REQUEST', 'Invalid request id');
  }
  return null;
}

function validateSettings(message) {
  if (!message.settings || typeof message.settings !== 'object' || Array.isArray(message.settings)) {
    return bridgeError('INVALID_SETTINGS', 'Invalid settings payload');
  }
  for (const key of Object.keys(message.settings)) {
    if (!['intercept', 'overlay', 'confirmBeforeDownload'].includes(key)) {
      return bridgeError('INVALID_SETTINGS', `Unknown setting: ${key}`);
    }
    if (typeof message.settings[key] !== 'boolean') {
      return bridgeError('INVALID_SETTINGS', `Setting ${key} must be a boolean`);
    }
  }
  return null;
}

function validate(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return bridgeError('INVALID_MESSAGE', 'Invalid message');
  }
  if (message.version !== VERSION) {
    return bridgeError('UNSUPPORTED_VERSION', 'Unsupported bridge protocol version');
  }
  if (typeof message.type !== 'string' || !ALLOWED_TYPES.has(message.type)) {
    return bridgeError('UNSUPPORTED_TYPE', 'Unsupported operation');
  }
  if (message.type === 'enqueue') return validateEnqueue(message);
  if (message.type === 'settings:update') return validateSettings(message);
  return null;
}

function handleFrame(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    respond({ type: 'error', code: 'INVALID_JSON', error: 'Invalid JSON' });
    return;
  }
  const id = normalizeId(message && message.id);
  const invalid = validate(message);
  if (invalid) {
    respond({ type: 'error', code: invalid.code || 'INVALID_MESSAGE', error: invalid.message }, id);
    return;
  }
  const request = { ...message };
  if (id) request.id = id;
  else delete request.id;

  pipeRequest(request)
    .then(response => {
      respond({ ...response, id: id || response.id }, id || response.id);
    })
    .catch(error => {
      respond({
        type: 'error',
        code: error.code || 'PIPE_ERROR',
        error: error.message || 'Meldrix request failed'
      }, id);
    });
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > MAX_MESSAGE) {
      buffer = Buffer.alloc(0);
      respond({ type: 'error', code: 'MESSAGE_TOO_LARGE', error: 'Message too large' });
      return;
    }
    if (buffer.length < 4 + length) return;
    const raw = buffer.subarray(4, 4 + length).toString('utf8');
    buffer = buffer.subarray(4 + length);
    handleFrame(raw);
  }
});

process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
process.on('uncaughtException', error => {
  try { process.stderr.write(`[meldrix-native] ${error && error.stack ? error.stack : error}\n`); } catch { /* ignore */ }
});
process.on('unhandledRejection', error => {
  try { process.stderr.write(`[meldrix-native] unhandled rejection ${error && error.stack ? error.stack : error}\n`); } catch { /* ignore */ }
});
