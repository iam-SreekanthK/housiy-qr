/* Host-side "scan to join" QR code.
 *
 * The QR encodes a full absolute URL built from wherever the app is actually
 * served (current origin + current directory), so it is correct on any
 * domain, port or sub-path without configuration:
 *     https://<your-domain>/<app-path>/index.html?room=<ROOM_CODE>
 * index.html reads ?room=, pre-fills the Room ID and either asks for name +
 * email or, for an already signed-in player, joins straight away.
 *
 * The QR is drawn locally as inline SVG (vendored qrcode-generator, MIT), so
 * it needs no external service and works under the strict CSP.
 */
(function () {
  'use strict';

  const roomCode = (new URLSearchParams(window.location.search).get('room') || '').trim().toUpperCase();
  if (!roomCode) return;

  /** Absolute join link for this room, derived from the live page URL. */
  function buildJoinUrl() {
    const url = new URL('index.html', window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', roomCode);
    return url.toString();
  }

  /** Renders `text` as a crisp, scalable inline-SVG QR with a 4-module quiet zone. */
  function renderQrSvg(text) {
    if (typeof qrcode !== 'function') throw new Error('QR library not loaded');
    const qr = qrcode(0, 'M'); // auto version, medium error correction
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const size = n + quiet * 2;
    let path = '';
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!qr.isDark(r, c)) { c++; continue; }
        let start = c;
        while (c < n && qr.isDark(r, c)) c++;
        path += `M${start + quiet} ${r + quiet}h${c - start}v1h-${c - start}z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code to join room ${roomCode}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  let overlay = null;
  let lastFocus = null;

  function closeQr() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onKeydown, true);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }
  function onKeydown(e) { if (e.key === 'Escape') { e.preventDefault(); closeQr(); } }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error('clipboard unavailable'));
  }

  function openQr() {
    if (overlay) return;
    lastFocus = document.activeElement;
    const joinUrl = buildJoinUrl();
    let svg;
    try { svg = renderQrSvg(joinUrl); }
    catch (err) {
      console.error('[Housiy] QR failed:', err);
      if (typeof showToast === 'function') showToast('Could not generate the QR code', 'danger');
      return;
    }

    overlay = document.createElement('div');
    overlay.className = 'rematch-modal-overlay qr-modal-overlay';
    overlay.setAttribute('role', 'presentation');
    overlay.innerHTML = `
      <div class="glass rematch-modal-card qr-modal-card" role="dialog" aria-modal="true" aria-labelledby="qrModalTitle">
        <h6 id="qrModalTitle">Scan to join this room</h6>
        <div class="text-dim small">Players scan with their phone camera</div>
        <div class="qr-box">${svg}</div>
        <div class="qr-room-code"></div>
        <div class="qr-url-row">
          <input class="form-control form-control-sm" id="qrJoinUrl" readonly aria-label="Join link">
          <button type="button" class="btn btn-sm btn-outline-glass" id="qrCopyLink">Copy link</button>
        </div>
        <div class="qr-hint">New players can join only before the game starts.</div>
        <div class="d-flex justify-content-end mt-3">
          <button type="button" class="btn btn-accent btn-sm" id="qrCloseBtn">Close</button>
        </div>
      </div>`;
    // Text goes in via textContent/value, never interpolated into markup.
    overlay.querySelector('.qr-room-code').textContent = roomCode;
    const urlInput = overlay.querySelector('#qrJoinUrl');
    urlInput.value = joinUrl;
    urlInput.addEventListener('focus', () => urlInput.select());

    overlay.querySelector('#qrCloseBtn').addEventListener('click', closeQr);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeQr(); });
    overlay.querySelector('#qrCopyLink').addEventListener('click', () => {
      copyText(joinUrl)
        .then(() => { if (typeof showToast === 'function') showToast('Join link copied to clipboard', 'success'); })
        .catch(() => { urlInput.focus(); urlInput.select(); if (typeof showToast === 'function') showToast('Press Ctrl+C to copy the link', 'primary'); });
    });

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown, true);
    overlay.querySelector('#qrCloseBtn').focus();
  }

  function wire(id, closeMenu) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (closeMenu) {
        const menu = document.getElementById('mobileMenu');
        if (menu) menu.classList.remove('show');
      }
      openQr();
    });
  }
  wire('qrBtn', false);
  wire('mobileQrBtn', true);

  // Exposed for tests / other host-page code.
  window.housiyJoinUrl = buildJoinUrl;
})();
