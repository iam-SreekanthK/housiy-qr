'use strict';
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const host = read('src/host.html'), index = read('src/index.html');
const qr = read('src/assets/js/qr-join.js'), page = read('src/assets/js/page-index.js');
const checks = [
  [/id="qrBtn"/.test(host) && /id="mobileQrBtn"/.test(host), 'host has a QR button on desktop and in the hamburger menu'],
  [/assets\/vendor\/qrcode\/qrcode\.js/.test(host) && /assets\/js\/qr-join\.js/.test(host), 'host loads the locally vendored QR library (CSP script-src self)'],
  [fs.existsSync(path.join(root, 'src/assets/vendor/qrcode/qrcode.js')), 'QR library is vendored, no CDN or external service'],
  [/new URL\('index\.html', window\.location\.href\)/.test(qr) && /searchParams\.set\('room'/.test(qr), 'QR URL is absolute and derived from the live domain/path'],
  [/textContent = roomCode/.test(qr) && /urlInput\.value = joinUrl/.test(qr), 'room code and URL are inserted as text, never as markup'],
  [/id="inviteBanner"/.test(index) && /id="inviteNotYouBtn"/.test(index), 'landing page has the invite banner'],
  [/function handleInviteLink|handleInviteLink\(\)/.test(page) && /get\('room'\)/.test(page), 'landing page reads ?room='],
  [/history\.replaceState/.test(page), '?room= is removed so Back never re-triggers an auto-join'],
  [/housiy_authenticated'\) === '1'/.test(page) && /joinRoomAndEnter\(\{ name: stored\.name/.test(page), 'signed-in players join automatically'],
  [/\[A-Z0-9\]\{3,32\}/.test(page), 'malformed room codes are ignored'],
];
let failed = 0;
for (const [ok, label] of checks) { if (ok) console.log('PASS ' + label); else { console.error('FAIL ' + label); failed++; } }
if (failed) process.exit(1);
console.log('ALL QR JOIN CONTRACT CHECKS PASSED');
