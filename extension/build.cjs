const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const archiver = require('archiver');

const root = path.resolve(__dirname, '..');
const extensionRoot = __dirname;
const outputRoot = path.join(root, 'dist', 'extensions');
const sharedFiles = [
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  'PRIVACY.md',
  'STORE-LISTING.md'
];
const browsers = ['chrome', 'edge'];
const browserExtensionIds = JSON.parse(fs.readFileSync(path.join(root, 'native-host', 'extension-origins.json'), 'utf8'));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function createIcon(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const center = (size - 1) / 2;
  const radius = size * 0.22;
  const scale = size / 128;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    pixels[row] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const round = Math.max(Math.abs(dx), Math.abs(dy)) <= center - radius ||
        Math.hypot(Math.max(Math.abs(dx) - (center - radius), 0), Math.max(Math.abs(dy) - (center - radius), 0)) <= radius;
      const shaft = Math.abs(x - center) <= 8 * scale && y >= 28 * scale && y <= 82 * scale;
      const left = y >= 55 * scale && y <= 91 * scale && x <= center && x >= center - (y - 55 * scale);
      const right = y >= 55 * scale && y <= 91 * scale && x >= center && x <= center + (y - 55 * scale);
      const arrow = shaft || left || right;
      const offset = row + 1 + x * 4;
      if (round && arrow) pixels.set([255, 255, 255, 255], offset);
      else if (round) pixels.set([82, 105, 222, 255], offset);
      else pixels.set([0, 0, 0, 0], offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function deriveExtensionId(key) {
  const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16);
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('').replace(/[0-9a-f]/g, character => String.fromCharCode(97 + Number.parseInt(character, 16)));
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function centralDirectoryNames(zip) {
  const names = [];
  for (let offset = 0; offset + 46 <= zip.length; offset++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return names;
}

async function createZip(sourceDirectory, destination) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDirectory, false);
    const finalized = archive.finalize();
    if (finalized && typeof finalized.catch === 'function') finalized.catch(reject);
  });
  const bytes = fs.readFileSync(destination);
  const names = centralDirectoryNames(bytes);
  if (!names.includes('manifest.json') || names.some(name => name.startsWith('/') || name.includes('../'))) {
    throw new Error(`${destination} is missing a root manifest or contains an unsafe archive path`);
  }
  return {
    file: destination,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    files: names
  };
}

async function buildBrowser(browser) {
  if (!browsers.includes(browser)) throw new Error(`Unknown browser target: ${browser}`);
  const source = path.join(extensionRoot, browser);
  const manifestPath = path.join(source, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.background?.service_worker !== 'background.js') {
    throw new Error(`${browser} manifest must use the MV3 background service worker`);
  }
  const extensionId = deriveExtensionId(manifest.key);
  if (browserExtensionIds[browser] !== extensionId) {
    throw new Error(`${browser} manifest key resolves to ${extensionId}, but native-host/extension-origins.json declares ${browserExtensionIds[browser]}`);
  }
  const unpacked = path.join(outputRoot, browser, 'unpacked');
  fs.rmSync(unpacked, { recursive: true, force: true });
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of sharedFiles) copyFile(path.join(extensionRoot, name), path.join(unpacked, name));
  copyFile(path.join(source, 'README.md'), path.join(unpacked, 'README.md'));
  for (const size of [16, 32, 48, 128]) {
    const iconPath = path.join(unpacked, 'icons', `icon-${size}.png`);
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(iconPath, createIcon(size));
  }
  const archiveName = browser === 'chrome' ? 'Meldrix-Chrome-Extension.zip' : 'Meldrix-Edge-Extension.zip';
  const result = await createZip(unpacked, path.join(outputRoot, browser, archiveName));
  result.browser = browser;
  result.extensionId = extensionId;
  return result;
}

async function buildAll(target = 'all') {
  const targets = target === 'all' ? browsers : [target];
  const results = [];
  for (const browser of targets) results.push(await buildBrowser(browser));
  const installerTemplate = fs.readFileSync(path.join(root, 'build', 'installer.nsh.template'), 'utf8');
  const installerScript = installerTemplate
    .replaceAll('__CHROME_EXTENSION_ID__', browserExtensionIds.chrome)
    .replaceAll('__EDGE_EXTENSION_ID__', browserExtensionIds.edge);
  fs.writeFileSync(path.join(root, 'build', 'installer.nsh'), installerScript);
  for (const result of results) {
    console.log(`${result.browser}: ${result.file} (${result.size} bytes, SHA-256 ${result.sha256}, extension ID ${result.extensionId})`);
  }
  return results;
}

if (require.main === module) {
  buildAll(process.argv[2] || 'all').catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildAll, buildBrowser, centralDirectoryNames, deriveExtensionId };
