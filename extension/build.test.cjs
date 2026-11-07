const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildAll, centralDirectoryNames } = require('./build.cjs');
const origins = require('../native-host/extension-origins.json');

test('builds standalone Chrome and Edge MV3 archives with a root manifest', async () => {
  const results = await buildAll();
  assert.equal(results.length, 2);
  for (const result of results) {
    const unpacked = path.join(__dirname, '..', 'dist', 'extensions', result.browser, 'unpacked');
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'));
    const zip = fs.readFileSync(result.file);
    const names = centralDirectoryNames(zip);
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.equal(manifest.options_page, 'options.html');
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('background.js'));
    assert.ok(names.includes('options.html'));
    assert.ok(names.includes('icons/icon-128.png'));
    assert.ok(!names.some(name => name.includes('node_modules') || name.endsWith('.map')));
    assert.ok(names.includes('manifest.json') && !names.includes('unpacked/manifest.json'));
  }
  const installerHook = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  assert.ok(installerHook.includes(`chrome-extension://${origins.chrome}/`));
  assert.ok(installerHook.includes(`chrome-extension://${origins.edge}/`));
  assert.ok(installerHook.includes('Software\\Google\\Chrome\\NativeMessagingHosts'));
  assert.ok(installerHook.includes('Software\\Microsoft\\Edge\\NativeMessagingHosts'));
});
