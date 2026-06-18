'use strict';
// Copy the phone UI (mobile.html + icons) from the desktop repo into cloud/public so the cloud
// serves the EXACT same app the Mac does. Run before building the Docker image / deploying.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');           // bhatbot/
const PUB = path.join(__dirname, '..', 'public');
fs.mkdirSync(PUB, { recursive: true });

const copies = [
  [path.join(ROOT, 'src', 'mobile.html'), path.join(PUB, 'mobile.html')],
  [path.join(ROOT, 'src', 'mobile', 'icon-192.png'), path.join(PUB, 'icon-192.png')],
  [path.join(ROOT, 'src', 'mobile', 'icon-512.png'), path.join(PUB, 'icon-512.png')],
];
let n = 0;
for (const [src, dst] of copies) {
  try { fs.copyFileSync(src, dst); n++; console.log('synced', path.basename(dst)); }
  catch (e) { console.warn('skip', path.basename(dst), '-', e.message); }
}
console.log(`[sync-ui] ${n}/${copies.length} files synced into public/`);
