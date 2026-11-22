'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { version } = require('../package.json');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'release', version);
const files = [`MossLauncher-Setup-${version}-x64.exe`, `MossLauncher-Portable-${version}-x64.exe`];
async function main() {
  const sums = [];
  for (const name of files) {
    const file = path.join(destination, name);
    const descriptor = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(64);
      fs.readSync(descriptor, header, 0, 64, 0);
      if (header.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid executable: ' + name);
      const signature = Buffer.alloc(4);
      fs.readSync(descriptor, signature, 0, 4, header.readUInt32LE(60));
      if (signature.toString('hex') !== '50450000') throw new Error('Invalid PE: ' + name);
    } finally { fs.closeSync(descriptor); }
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    sums.push(`${hash.digest('hex')}  ${name}`);
    console.log(`${name}: ${(fs.statSync(file).size / 1048576).toFixed(1)} MiB`);
  }
  fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  for (const name of ['README-RU.txt', 'THIRD-PARTY-NOTICES.txt']) {
    fs.copyFileSync(path.join(root, 'distribution', name), path.join(destination, name));
  }
  fs.copyFileSync(path.join(root, 'TEST-REPORT.md'), path.join(destination, 'TEST-REPORT.md'));
  console.log('Release files and SHA-256 checksums prepared.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
