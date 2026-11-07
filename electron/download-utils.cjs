const fs = require('fs');
const path = require('path');

function uniqueDownloadName(name, destination, isReserved) {
  const parsed = path.parse(name);
  let candidate = parsed.base;
  let suffix = 1;
  while (fs.existsSync(path.join(destination, candidate))
    || fs.existsSync(`${path.join(destination, candidate)}.meldrix.part`)
    || isReserved(candidate)) {
    candidate = `${parsed.name} (${suffix++})${parsed.ext}`;
  }
  return candidate;
}

function parseContentRange(value, expectedStart) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value || '');
  if (!match || Number(match[1]) !== expectedStart || Number(match[2]) < expectedStart) {
    throw new Error('The server returned an invalid byte range; retry the download from the beginning');
  }
  if (match[3] === '*') return 0;
  const total = Number(match[3]);
  if (!Number.isSafeInteger(total) || total <= Number(match[2])) {
    throw new Error('The server returned an invalid byte range; retry the download from the beginning');
  }
  return total;
}

function assertCompleteFile(written, observed, expected) {
  if (written !== observed || (expected > 0 && written !== expected)) {
    throw new Error(`The downloaded file is incomplete (${written} of ${expected || 'unknown'} bytes)`);
  }
}

module.exports = { uniqueDownloadName, parseContentRange, assertCompleteFile };
