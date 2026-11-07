const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

test('download handlers complete, pause/resume, verify progress, and retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldrix-download-test-'));
  const userData = path.join(root, 'user-data');
  const destination = path.join(root, 'downloads');
  const handlers = new Map();
  const sent = [];
  const app = new EventEmitter();
  app.isPackaged = false;
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve();
  app.getPath = key => key === 'userData' ? userData : destination;
  app.getAppPath = () => process.cwd();
  app.getVersion = () => 'test';
  app.setAppUserModelId = () => {};
  app.quit = () => {};

  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, value) => sent.push({ channel, value });
      this.webContents.isLoadingMainFrame = () => false;
      this.webContents.loadFile = () => Promise.resolve();
    }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    loadFile() { return Promise.resolve(); }
  }
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
  }
  const electron = {
    app,
    BrowserWindow,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Tray,
    Menu: { buildFromTemplate: value => value },
    nativeImage: { createEmpty: () => ({}) },
    Notification: { isSupported: () => false },
    shell: { openPath: async () => '', openExternal: async () => {} },
    dialog: { showMessageBox: async () => ({ response: 0 }), showErrorBox() {}, showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
  };
  const originalLoad = Module._load;
  const originalCreateServer = require('node:net').createServer;
  const originalExecFileSync = require('node:child_process').execFileSync;
  const log = { transports: { file: {} }, info() {}, warn() {}, error() {} };
  let server;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return electron;
      if (request === 'electron-log') return log;
      if (request === 'child_process') {
        const childProcess = originalLoad.call(this, request, parent, isMain);
        return { ...childProcess, execFileSync: () => { throw new Error('registry is not available in the test'); } };
      }
      if (request === 'node:net' || request === 'net') {
        const net = originalLoad.call(this, request, parent, isMain);
        return { ...net, createServer: () => ({ on() { return this; }, listen(_name, callback) { callback(); }, close() {} }) };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    require('./main.cjs');
    await waitFor(() => handlers.has('downloads:list'), 'IPC handlers');
    await waitFor(() => fs.existsSync(path.join(userData, 'meldrix.sqlite')), 'database initialization');

    const data = Buffer.alloc(512 * 1024);
    for (let index = 0; index < data.length; index++) data[index] = index % 251;
    let failures = 0;
    const rangeStarts = [];
    let activeLimitedRequests = 0;
    let maxLimitedRequests = 0;
    server = http.createServer((request, response) => {
      if (request.url === '/fail-once' && failures++ === 0) {
        response.writeHead(503).end();
        return;
      }
      const start = request.headers.range ? Number(/^bytes=(\d+)-/.exec(request.headers.range)[1]) : 0;
      if (request.url === '/slow' && request.headers.range) rangeStarts.push(start);
      if (request.url === '/slow' || request.url === '/unknown' || request.url.startsWith('/limit/')) {
        const body = data.subarray(start);
        const limited = request.url.startsWith('/limit/');
        if (limited) {
          activeLimitedRequests++;
          maxLimitedRequests = Math.max(maxLimitedRequests, activeLimitedRequests);
        }
        let counted = limited;
        const finishRequest = () => {
          if (!counted) return;
          counted = false;
          activeLimitedRequests--;
        };
        response.writeHead(start ? 206 : 200, {
          'Accept-Ranges': 'bytes',
          ...(request.url === '/unknown' ? {} : { 'Content-Length': body.length }),
          ...(start ? { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } : {})
        });
        let offset = 0;
        const interval = setInterval(() => {
          if (response.destroyed) { clearInterval(interval); finishRequest(); return; }
          const next = body.subarray(offset, offset + 32 * 1024);
          offset += next.length;
          response.write(next);
          if (offset >= body.length) { clearInterval(interval); response.end(); }
        }, 20);
        response.on('close', () => { clearInterval(interval); finishRequest(); });
        return;
      }
      const body = data.subarray(start);
      response.writeHead(start ? 206 : 200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': body.length,
        ...(start ? { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } : {})
      });
      response.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const add = handlers.get('downloads:add');
    const list = handlers.get('downloads:list');

    const known = add(null, { url: `${baseUrl}/known`, name: 'known.bin', destination });
    await waitFor(async () => (await list()).find(row => row.id === known.id)?.status === 'completed', 'known-size download');
    assert.deepEqual(fs.readFileSync(path.join(destination, known.name)), data);

    const unknown = add(null, { url: `${baseUrl}/unknown`, name: 'unknown.bin', destination });
    await waitFor(() => sent.some(event => event.channel === 'downloads:progress'
      && event.value.id === unknown.id && event.value.downloaded > 0 && event.value.size === 0), 'unknown-size progress');
    await waitFor(async () => (await list()).find(row => row.id === unknown.id)?.status === 'completed', 'unknown-size download');
    const unknownRow = (await list()).find(row => row.id === unknown.id);
    assert.equal(unknownRow.size, data.length);

    const slow = add(null, { url: `${baseUrl}/slow`, name: 'slow.bin', destination });
    await waitFor(() => sent.some(event => event.channel === 'downloads:progress'
      && event.value.id === slow.id && event.value.downloaded > 0), 'partial bytes');
    await handlers.get('downloads:pause')(null, slow.id);
    await waitFor(async () => (await list()).find(row => row.id === slow.id)?.status === 'paused'
      && fs.existsSync(path.join(destination, `${slow.name}.meldrix.part`)), 'paused partial file');
    await handlers.get('downloads:resume')(null, slow.id);
    await waitFor(async () => (await list()).find(row => row.id === slow.id)?.status === 'completed', 'resumed download');
    assert.ok(rangeStarts.some(start => start > 0), 'resume should issue a byte-range request');
    assert.deepEqual(fs.readFileSync(path.join(destination, slow.name)), data);

    const failed = add(null, { url: `${baseUrl}/fail-once`, name: 'retry.bin', destination });
    await waitFor(async () => (await list()).find(row => row.id === failed.id)?.status === 'failed', 'initial failed attempt');
    await handlers.get('downloads:resume')(null, failed.id);
    await waitFor(async () => (await list()).find(row => row.id === failed.id)?.status === 'completed', 'retried download');
    assert.deepEqual(fs.readFileSync(path.join(destination, failed.name)), data);

    const duplicate = add(null, { url: `${baseUrl}/another`, name: 'known.bin', destination, startNow: false });
    assert.equal(duplicate.name, 'known (1).bin');

    await handlers.get('settings:set')(null, 'max_concurrent_downloads', '1');
    assert.throws(() => handlers.get('settings:set')(null, 'max_concurrent_downloads', '0'), /between 1 and 8/);
    const limitedFirst = add(null, { url: `${baseUrl}/limit/first`, name: 'limit-first.bin', destination });
    const limitedSecond = add(null, { url: `${baseUrl}/limit/second`, name: 'limit-second.bin', destination });
    assert.equal(limitedSecond.status, 'queued');
    await waitFor(async () => (await list()).filter(row => [limitedFirst.id, limitedSecond.id].includes(row.id)).every(row => row.status === 'completed'), 'concurrency-limited queue');
    assert.equal(maxLimitedRequests, 1);
    assert.equal(await handlers.get('settings:get')(null, 'max_concurrent_downloads'), '1');
    const queued = add(null, { url: `${baseUrl}/queued`, name: 'queued.bin', destination, startNow: false });
    assert.equal(queued.status, 'queued');
    await handlers.get('downloads:start-queue')();
    await waitFor(async () => (await list()).find(row => row.id === queued.id)?.status === 'completed', 'explicit queue start');
    await handlers.get('downloads:stop-queue')();

    const databasePath = path.join(userData, 'meldrix.sqlite');
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({ locateFile: file => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file) });
    const database = new SQL.Database(fs.readFileSync(databasePath));
    const partialPath = path.join(destination, `${slow.name}.meldrix.part`);
    const partialBytes = data.subarray(0, 1234);
    fs.writeFileSync(partialPath, partialBytes);
    database.run("UPDATE downloads SET status='downloading',downloaded=0,size=? WHERE id=?", [data.length, slow.id]);
    fs.writeFileSync(databasePath, Buffer.from(database.export()));
    database.close();
    delete require.cache[require.resolve('./main.cjs')];
    handlers.delete('downloads:list');
    require('./main.cjs');
    await waitFor(() => handlers.has('downloads:list'), 'restarted IPC handlers');
    await waitFor(async () => (await handlers.get('downloads:list')()).find(row => row.id === slow.id)?.status === 'paused', 'interrupted task recovery');
    const recovered = (await handlers.get('downloads:list')()).find(row => row.id === slow.id);
    assert.equal(recovered.downloaded, partialBytes.length);
    assert.equal(fs.statSync(partialPath).size, partialBytes.length);
  } finally {
    Module._load = originalLoad;
    require('node:net').createServer = originalCreateServer;
    require('node:child_process').execFileSync = originalExecFileSync;
    if (server) await new Promise(resolve => server.close(resolve));
    app.emit('before-quit');
    fs.rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 30000 });

async function waitFor(predicate, label) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: lastError });
}
