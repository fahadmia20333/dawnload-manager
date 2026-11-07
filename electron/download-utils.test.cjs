const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { uniqueDownloadName, parseContentRange, assertCompleteFile } = require('./download-utils.cjs');

test('chooses a distinct name when a completed file already exists', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldrix-name-'));
  try {
    fs.writeFileSync(path.join(directory, 'report.zip'), 'existing');
    assert.equal(uniqueDownloadName('report.zip', directory, () => false), 'report (1).zip');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reserves partial file names and active task names', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldrix-partial-'));
  try {
    fs.writeFileSync(path.join(directory, 'report.zip.meldrix.part'), 'partial');
    assert.equal(uniqueDownloadName('report.zip', directory, name => name === 'report (1).zip'), 'report (2).zip');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts a matching byte range and returns its total size', () => {
  assert.equal(parseContentRange('bytes 12-19/64', 12), 64);
});

test('rejects a resumed range that starts at a different offset', () => {
  assert.throws(() => parseContentRange('bytes 0-19/64', 12), /invalid byte range/i);
});

test('rejects a short or mismatched completed file', () => {
  assert.throws(() => assertCompleteFile(20, 20, 64), /incomplete/);
  assert.throws(() => assertCompleteFile(19, 20, 20), /incomplete/);
  assert.doesNotThrow(() => assertCompleteFile(20, 20, 20));
});
