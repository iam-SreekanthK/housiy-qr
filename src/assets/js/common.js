// Shared helpers used across host.html, player.html, admin.html

const API_BASE = '/api';

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ success: false, error: 'Invalid server response' }));
  if (!res.ok && data.success === undefined) {
    data.success = false;
  }
  return data;
}

const HOUSIY_TERMINAL_CACHE_PREFIX = 'housiy:completed-snapshot:v2:';
const HOUSIY_SNAPSHOT_DB = 'housiy-final-snapshots';
const HOUSIY_SNAPSHOT_STORE = 'snapshots';
// Keep user-specific ticket snapshots isolated between browser sessions/tabs.
function housiyCacheScope() {
  try { let id = sessionStorage.getItem('housiy_snapshot_scope'); if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`); sessionStorage.setItem('housiy_snapshot_scope', id); } return id; } catch (_) { return 'session'; }
}
function housiyIsTerminalPayload(data) {
  const game = String(data && data.game && data.game.status || '').toUpperCase();
  const room = String(data && data.room && data.room.status || data && data.room_status || '').toUpperCase();
  return ['COMPLETED', 'ENDED', 'CANCELLED'].includes(game) || ['COMPLETED', 'ENDED', 'CANCELLED'].includes(room);
}
function housiyTerminalCacheKey(path, params) {
  const room = String(params && (params.room_code || params.room || '') || '').toUpperCase();
  if (!room || !['ticket.php', 'results.php'].includes(String(path).split('?')[0])) return '';
  return HOUSIY_TERMINAL_CACHE_PREFIX + housiyCacheScope() + ':' + room + ':' + String(path).split('?')[0];
}

// Fast, network-free terminal-state check used before starting any page polling.
// A completed snapshot is scoped to this browser session and room.
async function housiyHasCachedTerminalState(roomCode) {
  const room = String(roomCode || '').trim().toUpperCase();
  if (!room) return false;
  const snapshotKey = `${HOUSIY_TERMINAL_CACHE_PREFIX}${housiyCacheScope()}:${room}:snapshot`;
  const snapshot = await housiySnapshotRead(snapshotKey);
  if (snapshot && snapshot.snapshot_version === 1 && housiyIsTerminalPayload(snapshot)) return true;
  for (const path of ['ticket.php', 'results.php']) {
    const cached = await housiySnapshotRead(housiyTerminalCacheKey(path, { room_code: room }));
    if (cached && cached.success && housiyIsTerminalPayload(cached)) return true;
  }
  return false;
}
function housiySnapshotDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open(HOUSIY_SNAPSHOT_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HOUSIY_SNAPSHOT_STORE)) db.createObjectStore(HOUSIY_SNAPSHOT_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}
async function housiySnapshotRead(key) {
  try {
    const db = await housiySnapshotDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(HOUSIY_SNAPSHOT_STORE, 'readonly').objectStore(HOUSIY_SNAPSHOT_STORE).get(key);
      request.onsuccess = () => resolve(request.result && request.result.value || null);
      request.onerror = () => reject(request.error);
      request.transaction.oncomplete = () => db.close();
    });
  } catch (_) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }
}
async function housiySnapshotWrite(key, value) {
  try {
    const db = await housiySnapshotDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HOUSIY_SNAPSHOT_STORE, 'readwrite');
      tx.objectStore(HOUSIY_SNAPSHOT_STORE).put({ key, value, savedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch (_) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* cache is optional */ }
  }
}
// Always fetch the authoritative server response. Use this for room lifecycle
// checks that may change after the game has completed (for example rematch
// creation); completed snapshots must never hide a later rematch_room_code.
async function apiGetFresh(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const separator = qs ? '&' : '?';
  const res = await fetch(`${API_BASE}/${path}${qs}${separator}_fresh=${Date.now()}`, {
    credentials: 'same-origin', cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }
  });
  return await res.json().catch(() => ({ success: false, error: 'Invalid server response' }));
}

async function apiGet(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const cacheKey = housiyTerminalCacheKey(path, params);
  // A stored final response is used only for the exact room + endpoint. It is
  // written only after the server has confirmed terminal state.
  if (cacheKey) {
    const cached = await housiySnapshotRead(cacheKey);
    if (cached && cached.success && housiyIsTerminalPayload(cached)) return cached;
  }
  const res = await fetch(`${API_BASE}/${path}${qs}`, { credentials: 'same-origin', cache: 'no-store' });
  const data = await res.json().catch(() => ({ success: false, error: 'Invalid server response' }));
  if (cacheKey && data && data.success && housiyIsTerminalPayload(data)) await housiySnapshotWrite(cacheKey, data);
  return data;
}

let housiyFinalSnapshotPromise = null;
async function housiySaveFinalSnapshot(roomCode) {
  const room = String(roomCode || '').trim().toUpperCase();
  if (!room) return null;
  const key = `${HOUSIY_TERMINAL_CACHE_PREFIX}${housiyCacheScope()}:${room}:snapshot`;
  const cached = await housiySnapshotRead(key);
  if (cached && cached.success && cached.snapshot_version === 1) return cached;
  if (housiyFinalSnapshotPromise) return housiyFinalSnapshotPromise;
  housiyFinalSnapshotPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/completed_snapshot.php?room_code=${encodeURIComponent(room)}`, { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (response.ok && data && data.success && data.snapshot_version === 1) await housiySnapshotWrite(key, data);
      return data;
    } catch (_) { return null; }
    finally { housiyFinalSnapshotPromise = null; }
  })();
  return housiyFinalSnapshotPromise;
}

function showToast(message, variant = 'primary') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    container.style.right = '20px';
    container.style.zIndex = '3000';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${variant} border-0 show mb-2`;
  // message is escaped here (not just at call sites) so this stays safe by
  // default even if a future caller passes user-controlled text.
  // Build the toast with DOM APIs. This avoids HTML parsing and guarantees
  // that no inline event-handler attribute can be introduced under strict CSP.
  const row = document.createElement('div');
  row.className = 'd-flex';
  const body = document.createElement('div');
  body.className = 'toast-body';
  body.textContent = String(message ?? '');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn-close btn-close-white me-2 m-auto';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => el.remove());
  row.append(body, close);
  el.appendChild(row);
  container.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/** Full-screen "5, 4, 3, 2, 1" countdown shown to every user — host and
 *  every player — right as the host starts the game. remainingMs is
 *  computed against the server's own started_at/server_now timestamps
 *  (see page-host.js / page-player.js), so a client whose poll landed a
 *  little late still counts down from the *correct* number rather than
 *  a fresh 5 — everyone lands on "GO!" together. The server itself
 *  holds back the very first number call for the same duration (see
 *  GameEngine::START_COUNTDOWN_SECONDS), so nothing gets called out
 *  from under the overlay. onDone (optional) fires once it's gone. */
function showStartCountdown(remainingMs, onDone) {
  if (document.getElementById('startCountdownOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'startCountdownOverlay';
  overlay.className = 'start-countdown-overlay';
  overlay.innerHTML = `
    <div class="start-countdown-label">Game starting in</div>
    <div class="start-countdown-number" id="startCountdownNumber"></div>`;
  document.body.appendChild(overlay);

  const numEl = overlay.querySelector('#startCountdownNumber');

  const speakTick = (text) => {
    if (!soundOn || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    applyRandomVoiceGender(utter, 1.0);
    speakOrQueue(utter, true);
  };

  const finish = () => {
    overlay.remove();
    if (typeof onDone === 'function') onDone();
  };

  let secondsLeft = Math.max(0, Math.round(remainingMs / 1000));
  if (secondsLeft <= 0) { finish(); return; }

  const tick = () => {
    if (secondsLeft <= 0) {
      numEl.textContent = 'GO!';
      numEl.classList.add('start-countdown-go');
      speakTick('Go!');
      setTimeout(finish, 700);
      return;
    }
    numEl.textContent = String(secondsLeft);
    numEl.style.animation = 'none';
    void numEl.offsetWidth;
    numEl.style.animation = '';
    speakTick(String(secondsLeft));
    secondsLeft -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

/** Shows the "someone just won" banner: winner name + prize on the first
 *  line, their email in brackets underneath, visible to every user in
 *  the room. */
// One announcement path for host and every player. The WebSocket event,
// event-triggered snapshot refresh, and reconnect fallback can all observe the
// same committed claim. Keep the idempotency registry on window so every page
// handler in this browser shares the same guard. A prize can be announced only
// once per game, regardless of how many delivery/reconciliation paths see it.
const roomWinnerAnnouncements = window.__housiyRoomWinnerAnnouncements instanceof Set
  ? window.__housiyRoomWinnerAnnouncements
  : (window.__housiyRoomWinnerAnnouncements = new Set());
// Winner alerts play one at a time. Each one shows the drop-down banner and
// speaks the winner phrase; the next starts only after the banner has been
// up for its minimum time AND the voice has finished (or a safety timeout
// fires), so two prizes won back-to-back never overlap or cut each other off.
// The server also holds number calling for the same window (see
// GameEngine::WINNER_ANNOUNCE_HOLD_SECONDS), so no number is called, and
// therefore none can be missed, while this runs.
const WINNER_BANNER_MIN_MS = 4500;
const WINNER_ANNOUNCE_MAX_MS = 14000; // safety net if speech never reports its end
const winnerAnnounceQueue = [];
let winnerAnnounceRunning = false;
window.housiyWinnerAnnouncementActive = false;

const winnerAnnouncementDrainCallbacks = [];
function afterWinnerAnnouncements(callback) {
  if (typeof callback !== 'function') return;
  if (!winnerAnnounceRunning && winnerAnnounceQueue.length === 0) {
    callback();
    return;
  }
  winnerAnnouncementDrainCallbacks.push(callback);
}
function notifyWinnerAnnouncementsDrained() {
  if (winnerAnnounceRunning || winnerAnnounceQueue.length > 0) return;
  window.housiyWinnerAnnouncementActive = false;
  const callbacks = winnerAnnouncementDrainCallbacks.splice(0);
  callbacks.forEach(callback => {
    try { callback(); } catch (error) { console.error('[Housiy] final winner callback failed:', error); }
  });
}
function runNextWinnerAnnouncement() {
  if (winnerAnnounceRunning) return;
  const item = winnerAnnounceQueue.shift();
  if (!item) { notifyWinnerAnnouncementsDrained(); return; }
  winnerAnnounceRunning = true;
  window.housiyWinnerAnnouncementActive = true;

  const banner = showWinnerBanner(item.winnerName, item.label, item.winnerEmail);
  let minElapsed = false;
  let voiceDone = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(maxTimer);
    dismissWinnerBanner(banner);
    // Let the banner's exit animation play before the next alert drops in.
    setTimeout(() => {
      winnerAnnounceRunning = false;
      runNextWinnerAnnouncement();
    }, 350);
  };
  const tryFinish = () => { if (minElapsed && voiceDone) finish(); };
  const maxTimer = setTimeout(finish, WINNER_ANNOUNCE_MAX_MS);
  setTimeout(() => { minElapsed = true; tryFinish(); }, WINNER_BANNER_MIN_MS);
  // Voice is queued behind any number call already being spoken, so that
  // number finishes first, then the winner phrase plays in full.
  speakPhrase(`${item.winnerName} won ${item.label}!`, () => { voiceDone = true; tryFinish(); });
}

/** English ordinal for a small positive number: 1 -> "1st", 2 -> "2nd". */
function winnerOrdinal(n) {
  n = Number(n) || 1;
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
}

/** Identity of one prize award. Only Full House can have several winners
 *  (positions 1..5); every other prize keeps its plain type as the key, so
 *  single-winner rooms behave exactly as before. */
function winnerKey(prizeType, position) {
  const prize = String(prizeType || '').toUpperCase();
  const pos = Number(position) || 1;
  return prize === 'FULL_HOUSE' && pos > 1 ? `${prize}#${pos}` : prize;
}

/** Text for a prize on a claim button. Full House with several winners shows
 *  how many are still up for grabs, e.g. "Full House (2)". */
function prizeClaimLabel(prizeType, baseLabel, room) {
  if (String(prizeType) === 'FULL_HOUSE' && room) {
    const total = Number(room.full_house_total || 1);
    const remaining = Number(room.full_house_remaining ?? total);
    if (total > 1 && remaining > 0) return `${baseLabel} (${remaining})`;
  }
  return baseLabel;
}

/** Sets one claim button from the shared claim state:
 *   { prizesWon, prizesWonByMe, full_house_total, full_house_remaining }
 *  - a prize is closed for everyone once all its winner slots are filled;
 *  - a player who has already won Full House gets a green, closed button
 *    even while the remaining slots stay open for everyone else;
 *  - Full House with several winners shows the slots left, e.g. "Full House (2)". */
function applyClaimButtonState(btn, prize, state, baseLabel) {
  const prizesWon = state.prizesWon || [];
  const mine = (state.prizesWonByMe || []).includes(prize);
  const closed = prizesWon.includes(prize) || (prize === 'FULL_HOUSE' && mine);
  btn.disabled = closed;
  btn.classList.toggle('claimed', closed);
  btn.classList.toggle('claimed-self', closed && mine);
  btn.textContent = closed ? baseLabel : prizeClaimLabel(prize, baseLabel, state);
}

/** Prize name for a winners list row; adds "(2nd)" when the room has several Full House winners. */
function winnerListPrizeLabel(w, baseLabel, multiFullHouse) {
  if (multiFullHouse && String(w.prize_type || '').toUpperCase() === 'FULL_HOUSE') {
    return `${baseLabel} (${winnerOrdinal(w.winner_position)})`;
  }
  return baseLabel;
}

function announceRoomWinnerOnce(winnerName, prizeType, winnerEmail = null, position = 1, total = 1) {
  const prize = String(prizeType || '').toUpperCase().trim();
  if (!prize) return false;
  const roomKey = String((typeof roomCode !== 'undefined' && roomCode) || window.housiyRoomCode || '').toUpperCase();
  const key = winnerKey(prize, position);
  const announcementKey = `${roomKey}:${key}`;
  if (roomWinnerAnnouncements.has(announcementKey) || roomWinnerAnnouncements.has(key)) return false;
  // Mark before touching DOM or speechSynthesis: a second event arriving in
  // the same task/microtask cannot enqueue a second voice utterance.
  roomWinnerAnnouncements.add(announcementKey);
  roomWinnerAnnouncements.add(key);
  let label = ({FIRST_FIVE:'First Five',TOP_ROW:'Top Row',MIDDLE_ROW:'Middle Row',BOTTOM_ROW:'Bottom Row',FULL_HOUSE:'Full House'})[prize] || prize.replaceAll('_', ' ');
  // With several Full House winners, say which one this is ("Full House, 2nd winner").
  if (prize === 'FULL_HOUSE' && Number(total) > 1) label = `${label} (${winnerOrdinal(position)} winner)`;
  winnerAnnounceQueue.push({ winnerName: winnerName || 'A player', label, winnerEmail });
  runNextWinnerAnnouncement();
  return true;
}
function resetRoomWinnerAnnouncements() { roomWinnerAnnouncements.clear(); }

// Never expose a winner's full email address in room-wide UI.
function maskWinnerEmail(email) {
  const value = String(email || '').trim();
  if (!value) return '';
  // results.php already applies the Participants-list privacy format. Keep
  // that value unchanged instead of masking it a second time.
  const at = value.lastIndexOf('@');
  if (at > 0 && (value.slice(0, at).includes('*') || value.slice(0, at).includes('..'))) return value;
  if (at <= 0 || at === value.length - 1) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const masked = local.length <= 1 ? '*' : local.length <= 4
    ? `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}`
    : `${local.slice(0, 2)}..${local.slice(-2)}`;
  return `${masked}@${domain}`;
}

function showWinnerBanner(winnerName, prizeLabel, winnerEmail) {
  const banner = document.createElement('div');
  banner.className = 'winner-banner';
  banner.innerHTML = `
    <div class="winner-banner-name-line"><span class="winner-banner-trophy" aria-hidden="true">🏆</span><span class="winner-banner-name">${escapeHtml(winnerName || 'A player')}</span></div>
    ${winnerEmail ? `<div class="winner-banner-email">(${escapeHtml(maskWinnerEmail(winnerEmail))})</div>` : ''}
    <div class="winner-banner-won">won</div>
    <div class="winner-banner-prize">${escapeHtml(prizeLabel)}!</div>`;
  document.body.appendChild(banner);
  fireConfetti();
  fireBalloons();
  return banner;
}

/** Slides the drop-down winner banner back up, then removes it. */
function dismissWinnerBanner(banner) {
  if (!banner || !banner.parentNode) return;
  banner.classList.add('winner-banner-out');
  setTimeout(() => banner.remove(), 320);
}

function fireConfetti(count = 80) {
  const colors = ['#7c5cff', '#22d3ee', '#f5c451', '#34d399', '#f87171'];
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (2 + Math.random() * 1.5) + 's';
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 4000);
  }
}

/** Extra effect layered on top of the falling confetti: balloons rising
 *  from the bottom of the screen up to the top, with a bit of side drift. */
function fireBalloons(count = 14) {
  const colors = ['#7c5cff', '#22d3ee', '#f5c451', '#34d399', '#f87171', '#f472b6'];
  for (let i = 0; i < count; i++) {
    const balloon = document.createElement('div');
    balloon.className = 'balloon-piece';
    balloon.style.left = Math.random() * 100 + 'vw';
    balloon.style.background = colors[Math.floor(Math.random() * colors.length)];
    balloon.style.animationDuration = (3.5 + Math.random() * 2) + 's';
    balloon.style.animationDelay = (Math.random() * 0.6) + 's';
    balloon.style.setProperty('--drift', Math.round(Math.random() * 120 - 60) + 'px');
    balloon.style.setProperty('--sway', Math.round(Math.random() * 24 - 12) + 'deg');
    document.body.appendChild(balloon);
    setTimeout(() => balloon.remove(), 6500);
  }
}

const FINAL_BANNER_PRIZE_LABELS = {
  FIRST_FIVE: 'First Five', TOP_ROW: 'Top Row', MIDDLE_ROW: 'Middle Row',
  BOTTOM_ROW: 'Bottom Row', FULL_HOUSE: 'Full House',
};

/** Firework-style bursts (radiating sparks from a point) layered in with
 *  the confetti/balloons for the game-over celebration. */
function fireFireworks(bursts = 4) {
  const colors = ['#ffd166', '#f45b69', '#7c5cff', '#22d3ee', '#34d399', '#f472b6'];
  for (let b = 0; b < bursts; b++) {
    const cx = 12 + Math.random() * 76;
    const cy = 14 + Math.random() * 40;
    const delay = b * 0.35 + Math.random() * 0.2;
    const particleCount = 16;
    for (let i = 0; i < particleCount; i++) {
      const angle = (Math.PI * 2 * i) / particleCount;
      const dist = 55 + Math.random() * 45;
      const dx = Math.round(Math.cos(angle) * dist);
      const dy = Math.round(Math.sin(angle) * dist);
      const spark = document.createElement('div');
      spark.className = 'firework-spark';
      spark.style.left = cx + 'vw';
      spark.style.top = cy + 'vh';
      spark.style.background = colors[Math.floor(Math.random() * colors.length)];
      spark.style.setProperty('--dx', dx + 'px');
      spark.style.setProperty('--dy', dy + 'px');
      spark.style.animationDelay = delay + 's';
      document.body.appendChild(spark);
      setTimeout(() => spark.remove(), (delay + 1) * 1000 + 200);
    }
  }
}

/** Shown once, the moment the game ends (Full House claimed / all 90
 *  numbers called) — one compact, no-scroll banner-style card listing
 *  every prize and who won it, instead of only the one-at-a-time popups
 *  as each prize lands. Celebrates with confetti/balloons/fireworks and a
 *  spoken "Congratulations" line, and stays up until closed (see below).
 *  Only called when at least one prize was actually won — see the
 *  winners.length guard at each call site — so a game ended with no
 *  claims doesn't trigger this celebratory card/voice at all. */
function showFinalWinnersBanner(winners, onClose) {
  // The final summary replaces individual winner banners for every prize in
  // this completed game. This also suppresses the trailing WINNER_DECLARED
  // event that may follow GAME_FINISHED in the same Redis publication batch.
  (winners || []).forEach(w => {
    const key = winnerKey(w.prize_type, w.winner_position);
    if (key) roomWinnerAnnouncements.add(key);
  });
  const fullHouseCount = (winners || []).filter(w => String(w.prize_type || '').toUpperCase() === 'FULL_HOUSE').length;
  const already = document.getElementById('finalWinnersOverlay');
  if (already) already.remove();

  const overlay = document.createElement('div');
  overlay.id = 'finalWinnersOverlay';
  overlay.className = 'final-winners-overlay';

  const rows = (winners || []).map(w => {
    let label = FINAL_BANNER_PRIZE_LABELS[w.prize_type] || String(w.prize_type).replace(/_/g, ' ');
    if (String(w.prize_type).toUpperCase() === 'FULL_HOUSE' && fullHouseCount > 1) label += ` (${winnerOrdinal(w.winner_position)})`;
    return `
      <div class="final-winners-row">
        <span class="final-winners-prize">${escapeHtml(label)}</span>
        <span class="final-winners-name">
          ${escapeHtml(w.winner_name)}${w.winner_email ? ` <span class="final-winners-email">(${escapeHtml(maskWinnerEmail(w.winner_email))})</span>` : ''}
        </span>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="final-winners-card">
      <div class="final-winners-title">🏆 Full House! Game Over</div>
      <div class="final-winners-sub">🎉 Congratulations to all our winners! 🎉</div>
      <div class="final-winners-list">${rows}</div>
      <button type="button" class="btn btn-accent btn-sm final-winners-close">Close</button>
    </div>`;
  document.body.appendChild(overlay);
  window.dispatchEvent(new CustomEvent('housiy:final-winners-opened'));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    window.dispatchEvent(new CustomEvent('housiy:final-winners-closed'));
    if (typeof onClose === 'function') onClose();
  };
  overlay.querySelector('.final-winners-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  // No auto-dismiss on purpose: the winner card stays up until the
  // player closes it themselves, or the host starts a rematch (see
  // closeFinalWinnersOverlay, called from the rematch-detection code
  // in page-player.js / page-host.js).

  fireConfetti(120);
  fireBalloons(24);
  fireFireworks(4);
  speakPhrase('Congratulations to all our winners! What a game!');
}

/** Shows the top-down "X won Full House!" banner + confetti/balloons
 *  first, and only brings in the final winners card once that banner
 *  has had time to play out — rather than both appearing on top of
 *  each other in the same instant. onClose (optional) fires once the
 *  viewer dismisses the card — the host page uses this to head back
 *  to the home screen. */
const finalWinnersSummaryShown = new Set();
function showFinalWinnersOnce(winners, gameKey = 'current', onClose) {
  const key = String(gameKey || 'current');
  if (!Array.isArray(winners) || winners.length === 0 || finalWinnersSummaryShown.has(key)) return false;
  finalWinnersSummaryShown.add(key);

  // Make sure every Full House winner has had their individual announcement.
  // Prize events normally enqueue these first, but this also covers a game_ended
  // event/snapshot that reaches the browser before the final prize_won event.
  const fullHouseWinners = winners.filter(w => String(w.prize_type || '').toUpperCase() === 'FULL_HOUSE');
  fullHouseWinners.forEach(w => {
    announceRoomWinnerOnce(
      w.winner_name,
      'FULL_HOUSE',
      w.winner_email || null,
      w.winner_position || 1,
      fullHouseWinners.length
    );
  });

  // Do not display the final card on a fixed delay. Wait until the last
  // individual winner banner has completed and its exit animation has closed.
  afterWinnerAnnouncements(() => {
    showFinalWinnersBanner(winners, onClose);
  });
  return true;
}
function scheduleFinalWinnersBanner(winners, delayMs = 0, onClose) {
  // Kept as a compatibility wrapper for snapshot/fallback callers. The normal
  // path is the room-wide GAME_FINISHED event carrying final_winners.
  setTimeout(() => showFinalWinnersOnce(winners, 'current', onClose), Math.max(0, delayMs));
}

/** Closes the final winners card if one is currently showing. Used when
 *  the host starts a rematch — the new room is a clean break, so the
 *  old game's summary card shouldn't linger for other players. */
function closeFinalWinnersOverlay() {
  const overlay = document.getElementById('finalWinnersOverlay');
  if (overlay) { overlay.remove(); window.dispatchEvent(new CustomEvent('housiy:final-winners-closed')); }
}

/** Render a 3x9 ticket grid into a container element as a tear-off style
 *  ticket card: a printed header with a ticket serial number, a
 *  perforation line, then the fully-ruled 3x9 grid (blanks included). */
function renderTicket(containerEl, grid, calledSet, markedSet, onCellClick, ticketId) {
  const serial = ticketId ? String(ticketId).padStart(6, '0') : '------';
  containerEl.classList.add('ticket-card');
  containerEl.innerHTML = `
    <div class="ticket-header">
      <span class="ticket-title">🎟️ Housiy Ticket</span>
      <span class="ticket-serial">No. ${serial}</span>
    </div>
    <div class="ticket-perforation"></div>
    <div class="housiy-ticket-grid"></div>`;
  const gridEl = containerEl.querySelector('.housiy-ticket-grid');
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 9; c++) {
      const val = grid[r][c];
      const cell = document.createElement('div');
      if (val === 0) {
        cell.className = 'ticket-cell blank';
      } else {
        const isCalled = calledSet.has(val);
        const isMarked = markedSet.has(val);
        cell.className = 'ticket-cell' + (isMarked ? ' marked' : (isCalled ? ' called-not-marked' : ''));
        cell.textContent = val;
        // Belt-and-suspenders against the mobile "Search Google for…" /
        // "Copy" bubble on long-press: CSS user-select:none stops most
        // browsers from starting a text selection at all, but some
        // Android WebViews still fire a native long-press context menu
        // on a text node regardless, so also swallow contextmenu and
        // selectstart directly on the cell.
        cell.addEventListener('contextmenu', (e) => e.preventDefault());
        cell.addEventListener('selectstart', (e) => e.preventDefault());
        if (isCalled && onCellClick) {
          cell.style.cursor = 'pointer';
          cell.addEventListener('click', () => onCellClick(val, cell));
        }
      }
      gridEl.appendChild(cell);
    }
  }
}

/** Keeps board-cell circles perfectly round. CSS aspect-ratio only
 *  produces true squares when the board's own box happens to already be
 *  in a 10:9 ratio — not guaranteed once the board panel is bounded by a
 *  fixed-height container (e.g. the host dashboard's board card), so
 *  instead we measure the board's actual box here and set an explicit
 *  --cell-size custom property sized to whichever axis is tighter. The
 *  board is then centered within any leftover space via
 *  justify/align-content. */
function sizeNumberBoard(boardEl) {
  const cols = 10, rows = 9;
  const cs = getComputedStyle(boardEl);
  const gap = parseFloat(cs.columnGap || cs.gap) || 0;
  const w = boardEl.clientWidth;
  const h = boardEl.clientHeight;
  if (!w || !h) return;
  const cellW = (w - gap * (cols - 1)) / cols;
  const cellH = (h - gap * (rows - 1)) / rows;
  const size = Math.max(6, Math.floor(Math.min(cellW, cellH)));
  boardEl.style.setProperty('--cell-size', size + 'px');
}

// Re-measure whenever a board's own box changes size — covers window
// resize, orientation change, and the board panel being resized by
// surrounding layout — without a manual resize listener per page.
const _boardResizeObserver = ('ResizeObserver' in window)
  ? new ResizeObserver((entries) => { entries.forEach((entry) => sizeNumberBoard(entry.target)); })
  : null;

/** Render the 1-90 number board for the host view. */
function renderBoard(containerEl, calledSet, currentNumber) {
  containerEl.innerHTML = '';
  containerEl.classList.add('number-board');
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= 90; n++) {
    const cell = document.createElement('div');
    cell.className = 'board-cell' + (calledSet.has(n) ? ' called' : '') + (n === currentNumber ? ' current' : '');
    cell.textContent = n;
    // Same long-press-context-menu guard as the ticket cells above.
    cell.addEventListener('contextmenu', (e) => e.preventDefault());
    cell.addEventListener('selectstart', (e) => e.preventDefault());
    frag.appendChild(cell);
  }
  containerEl.appendChild(frag);
  sizeNumberBoard(containerEl);
  if (_boardResizeObserver) _boardResizeObserver.observe(containerEl);
}

function statusPill(status) {
  const map = {
    LOBBY: ['pill-lobby', 'Lobby'],
    LIVE: ['pill-live', 'Live'],
    RUNNING: ['pill-live', 'Live'],
    PAUSED: ['pill-paused', 'Paused'],
    COMPLETED: ['pill-completed', 'Completed'],
    ENDED: ['pill-completed', 'Ended'],
    CANCELLED: ['pill-completed', 'Cancelled'],
    NOT_STARTED: ['pill-lobby', 'Not started'],
  };
  const [cls, label] = map[status] || ['pill-lobby', status];
  return `<span class="pill ${cls}">${label}</span>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/** Render the "who's in this room" list — visible to host and players alike. */
function renderPlayersList(containerEl, players) {
  if (!containerEl) return;
  const safePlayers = Array.isArray(players) ? players : [];
  // Keep the heading count synchronized with the list rendered below it.
  // The host is included whenever the server includes the host in room.players.
  const countEl = document.getElementById('participantsCount');
  if (countEl) countEl.textContent = String(safePlayers.length);
  if (safePlayers.length === 0) {
    containerEl.innerHTML = '<p class="text-dim small mb-0">No players yet.</p>';
    return;
  }
  containerEl.innerHTML = safePlayers.map(p => `
    <div class="player-chip">
      <span class="player-dot"></span>
      <span class="player-chip-text">
        <span class="player-chip-name">${escapeHtml(p.name)}${p.is_host ? ' <span class="host-badge">HOST</span>' : ''}</span>
        ${p.email ? `<span class="player-chip-email">(${escapeHtml(p.email)})</span>` : ''}
      </span>
    </div>`).join('');
}

/**
 * Numbers on the ticket required for a given prize (row prizes / full
 * house). Returns null for FIRST_FIVE, which is handled specially since
 * any 5 called+marked numbers qualify.
 */
function requiredNumbersForPrize(prizeType, grid) {
  const rowNums = (r) => grid[r].filter(v => v !== 0);
  switch (prizeType) {
    case 'TOP_ROW': return rowNums(0);
    case 'MIDDLE_ROW': return rowNums(1);
    case 'BOTTOM_ROW': return rowNums(2);
    case 'FULL_HOUSE': return grid.flat().filter(v => v !== 0);
    default: return null;
  }
}

/**
 * Fast client-side check before firing a claim request, purely for instant
 * feedback ("you still have 2 numbers pending"). The server always
 * re-validates against the real called_numbers + marked_numbers ledgers,
 * so this is a UX nicety, never the source of truth.
 * Returns { ok: true } | { ok: false, pendingCount, pendingNumbers, calledShort }
 */
function precheckClaim(prizeType, grid, calledSet, markedSet) {
  if (prizeType === 'FIRST_FIVE') {
    const all = grid.flat().filter(v => v !== 0);
    const calledOnTicket = all.filter(n => calledSet.has(n));
    if (calledOnTicket.length < 5) return { ok: false, calledShort: true };
    const markedCalledOnTicket = calledOnTicket.filter(n => markedSet.has(n));
    if (markedCalledOnTicket.length < 5) {
      return { ok: false, pendingCount: 5 - markedCalledOnTicket.length, pendingNumbers: [] };
    }
    return { ok: true };
  }

  const required = requiredNumbersForPrize(prizeType, grid);
  if (!required) return { ok: true };

  const notCalled = required.filter(n => !calledSet.has(n));
  if (notCalled.length > 0) return { ok: false, calledShort: true };

  const notMarked = required.filter(n => !markedSet.has(n));
  if (notMarked.length > 0) return { ok: false, pendingCount: notMarked.length, pendingNumbers: notMarked };

  return { ok: true };
}

/* ------------------------------------------------------------------
 * Voice calling — speaks each new number aloud so players don't have
 * to keep staring at the screen. Off by default (autoplay audio needs
 * a user gesture in most browsers); the sound button turns it on and
 * the choice is remembered per-device.
 * ---------------------------------------------------------------- */
const SOUND_PREF_KEY = 'housiy_sound_on';
let soundOn = localStorage.getItem(SOUND_PREF_KEY) === '1';
let voicesReady = [];
// Chrome may restore the saved Sound On preference after a reload while its
// speech engine remains locked until a fresh user gesture. Keep winner/number
// speech pending until the first interaction instead of silently dropping it.
let speechUnlocked = false;
const pendingSpeech = [];
function speakOrQueue(utterance, priority = false) {
  if (!soundOn || !('speechSynthesis' in window)) return false;
  if (!speechUnlocked) {
    if (priority) pendingSpeech.push({ utterance, priority: true });
    else {
      // Number calls are replaceable: retain only the newest call while locked.
      for (let i = pendingSpeech.length - 1; i >= 0; i--) {
        if (!pendingSpeech[i].priority) pendingSpeech.splice(i, 1);
      }
      pendingSpeech.push({ utterance, priority: false });
    }
    if (pendingSpeech.length > 12) pendingSpeech.splice(0, pendingSpeech.length - 12);
    return false;
  }
  try {
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
    return true;
  } catch (_) { return false; }
}
function unlockSpeechFromGesture() {
  if (speechUnlocked || !soundOn || !('speechSynthesis' in window)) return;
  speechUnlocked = true;
  try {
    const synth = window.speechSynthesis;
    synth.resume();
    // A zero-volume utterance unlocks Chrome's speech pipeline without an
    // extra audible message; actual queued announcements follow it.
    const unlockUtterance = new SpeechSynthesisUtterance(' ');
    unlockUtterance.volume = 0;
    unlockUtterance.onend = () => {
      while (pendingSpeech.length) {
        const item = pendingSpeech.shift();
        if (soundOn) synth.speak(item.utterance);
      }
    };
    unlockUtterance.onerror = () => {
      // Some Chrome builds do not emit onend for a silent unlock utterance.
      // Resume and drain on the next animation frame as a safe fallback.
      requestAnimationFrame(() => {
        while (pendingSpeech.length) {
          const item = pendingSpeech.shift();
          if (soundOn) synth.speak(item.utterance);
        }
      });
    };
    synth.speak(unlockUtterance);
  } catch (_) { speechUnlocked = false; }
}
if ('speechSynthesis' in window) {
  ['pointerdown', 'keydown', 'touchstart'].forEach(type =>
    window.addEventListener(type, unlockSpeechFromGesture, { once: true, capture: true, passive: true })
  );
  const loadVoices = () => { voicesReady = window.speechSynthesis.getVoices(); };
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice(gender) {
  if (gender) {
    const femaleHints = /female|zira|samantha|victoria|karen|tessa|moira|susan|fiona|kate|serena|allison|ava|joanna|salli|kendra|kimberly|amy|emma|ivy|aria|shimmer|nova|hazel|sonia|libby|olivia/i;
    const maleHints = /male|david|mark|daniel|alex(?!a)|fred|george|james|guy|matthew|justin|kevin|eric|brian|christopher|ryan|onyx|echo|thomas|oliver|arthur|rishi/i;
    const hints = gender === 'female' ? femaleHints : maleHints;
    const pool = voicesReady.filter(v => hints.test(v.name) && /^en/i.test(v.lang));
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    // Some browsers only expose one or two generic voices with no gender
    // in the name — fall back to any of them so pitch shaping below still
    // gives an audible male/female difference.
    const anyEnglish = voicesReady.filter(v => /^en/i.test(v.lang));
    if (anyEnglish.length) return anyEnglish[Math.floor(Math.random() * anyEnglish.length)];
  }
  return voicesReady.find(v => /en-(GB|IN|US|AU)/i.test(v.lang)) || voicesReady[0] || null;
}

/** Randomly picks 'male' or 'female' for the next utterance and applies a
 *  matching voice (if the browser/OS has one) plus a pitch nudge so the
 *  caller's voice noticeably varies from call to call, rather than always
 *  sounding the same. */
function applyRandomVoiceGender(utter, basePitch) {
  const gender = Math.random() < 0.5 ? 'female' : 'male';
  const voice = pickVoice(gender);
  if (voice) utter.voice = voice;
  const usedNamedVoice = voice && new RegExp(gender === 'female' ? 'female|zira|samantha|victoria|karen|tessa|moira|susan|fiona|kate|serena|allison|ava|joanna|salli|kendra|kimberly|amy|emma|ivy|aria|shimmer|nova|hazel|sonia|libby|olivia' : 'male|david|mark|daniel|alex|fred|george|james|guy|matthew|justin|kevin|eric|brian|christopher|ryan|onyx|echo|thomas|oliver|arthur|rishi', 'i').test(voice.name);
  // If we couldn't find an explicitly gendered voice, shape the pitch
  // instead so there's still an audible male/female alternation.
  utter.pitch = usedNamedVoice ? basePitch : (gender === 'female' ? basePitch + 0.3 : Math.max(0.6, basePitch - 0.25));
}

// Tracks whether a higher-priority utterance (a winner announcement) is
// currently speaking, so a number call landing at the same moment doesn't
// cut it off — it gets queued to speak right after instead.
let priorityUtteranceCount = 0; // winner/priority phrases speaking or queued

// Tracks whether a "number" utterance (as opposed to a winner phrase) is
// currently speaking or still queued. The on-screen current number and
// winner banner update the instant a poll picks up a new value, but speech
// takes real time to play out — on a fast auto-call interval the voice can
// fall further and further behind what's on screen, queueing up a backlog
// of stale numbers. We use this flag to detect that backlog and catch the
// voice back up to the display instead of letting it drift.
let pendingNumberCall = false;

// How fast auto-call is currently set to run, in seconds between numbers.
// Defaults to 8s (the platform default) until a page tells us otherwise via
// setCallPace(). Used to scale the speech rate so a full call ("1 5... 15")
// reliably finishes before (or right around) the next number lands, which
// is what keeps the voice in sync with the current-number display and
// winner banner instead of queueing up behind them.
let callIntervalSeconds = 8;

/** Called by host/player pages whenever they learn the room's current
 *  auto-call interval (from the poll response), so speech pacing tracks
 *  whatever the host has it set to right now. */
function setCallPace(seconds) {
  if (typeof seconds === 'number' && seconds > 0) callIntervalSeconds = seconds;
}

/** Maps the auto-call interval to a speech rate: short intervals need a
 *  faster rate so the full "digit-by-digit... number" phrase fits inside
 *  the gap before the next call, instead of spilling over and queueing up.
 *  Clamped to a range that stays intelligible. */
function rateForCallPace() {
  const s = callIntervalSeconds;
  if (s <= 3) return 1.55;
  if (s <= 4) return 1.35;
  if (s <= 5) return 1.2;
  if (s <= 6) return 1.05;
  if (s <= 8) return 0.92;
  return 0.85;
}

/** Speaks a called number: digit-by-digit first (avoids 15/50-style
 *  mishearing, same trick real bingo callers use), then the full number.
 *  Rate scales with the auto-call interval (see rateForCallPace) so the
 *  voice keeps pace with fast calling instead of lagging behind. */
function speakNumber(n) {
  if (!soundOn || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;

  // If a previous number call is still speaking or queued when this new
  // one lands, the voice has fallen behind the current-number display
  // (which already shows n). Drop the stale call and jump straight to
  // this one instead of queueing on top of it — that's what keeps voice,
  // current-number display, and winner banner in sync on a fast interval.
  // A winner announcement in progress is never interrupted.
  if (pendingNumberCall && priorityUtteranceCount === 0) {
    synth.cancel();
  }

  const digits = String(n).split('').join(' ');
  const phrase = n < 10 ? `Number ${n}` : `${digits}... ${n}`;
  const utter = new SpeechSynthesisUtterance(phrase);
  utter.rate = rateForCallPace();
  applyRandomVoiceGender(utter, 1.0);

  pendingNumberCall = true;
  const clearPending = () => { pendingNumberCall = false; };
  utter.onend = clearPending;
  utter.onerror = clearPending;

  // Whether or not something's currently playing, speak() queues this
  // utterance to play as soon as the engine is free — no need to branch
  // on synth.speaking/pending here.
  speakOrQueue(utter, false);
}

// Numbers that landed while this page was offline or behind (HTTP fallback poll,
// reconnect snapshot, sequence-gap recovery) arrive together in one snapshot. The
// normal path only speaks the newest one, so the others were never heard. Speak each
// missed number in call order (a little faster, so the voice catches up), then the
// newest at the normal pace. `numbers` must be in call order (the API guarantees it).
// Capped so a long outage does not read out minutes of backlog; the board still
// shows every called number. Live WebSocket events keep using speakNumber().
const MISSED_NUMBER_SPEECH_CAP = 6;
function speakMissedNumbers(numbers) {
  const list = (Array.isArray(numbers) ? numbers : []).map(Number).filter(Number.isInteger);
  if (!list.length) return;
  const latest = list[list.length - 1];
  if (list.length === 1 || !soundOn || !speechUnlocked || !('speechSynthesis' in window)) {
    speakNumber(latest);
    return;
  }
  const synth = window.speechSynthesis;
  // Whatever number call is still speaking is older than this snapshot: drop it,
  // but never interrupt a winner announcement.
  if (pendingNumberCall && priorityUtteranceCount === 0) synth.cancel();
  const batch = list.slice(-MISSED_NUMBER_SPEECH_CAP);
  batch.forEach((n, i) => {
    const isLatest = i === batch.length - 1;
    const digits = String(n).split('').join(' ');
    const utter = new SpeechSynthesisUtterance(n < 10 ? `Number ${n}` : `${digits}... ${n}`);
    const base = rateForCallPace();
    utter.rate = isLatest ? base : Math.min(2, base * 1.15);
    applyRandomVoiceGender(utter, 1.0);
    if (isLatest) {
      pendingNumberCall = true;
      const clearPending = () => { pendingNumberCall = false; };
      utter.onend = clearPending;
      utter.onerror = clearPending;
    }
    speakOrQueue(utter, false);
  });
}
window.housiySpeakMissedNumbers = speakMissedNumbers;

function speakPhrase(text, onDone) {
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    priorityUtteranceCount = Math.max(0, priorityUtteranceCount - 1);
    if (typeof onDone === 'function') onDone();
  };
  if (!soundOn || !('speechSynthesis' in window)) { if (typeof onDone === 'function') onDone(); return; }
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.98;
  applyRandomVoiceGender(utter, 1.0);
  // Counter, not a boolean: several phrases can be queued at once and a
  // number call must not cancel the queue until all of them have finished.
  priorityUtteranceCount += 1;
  utter.onend = done;
  utter.onerror = done;
  // Don't cancel() here: a claim landing while a number is mid-call must let
  // that number finish. speechSynthesis queues an utterance automatically
  // when you speak() without cancelling first, so the in-progress number
  // completes in full and this phrase plays right after it. Both are heard,
  // back-to-back, never overlapping and never cut off.
  const spoken = speakOrQueue(utter, true);
  // Speech engine still locked (no tap yet) or speak() failed: there is no
  // voice to wait for, so release callers (e.g. the winner banner) now.
  if (!spoken) done();
}

/** Wires a #soundToggle button: shows on/off state, persists the
 *  preference, and unlocks the browser's speech engine on first tap. */
function initSoundToggle() {
  const btn = document.getElementById('soundToggle');
  if (!btn) return;
  const render = () => {
    btn.dataset.on = soundOn ? 'true' : 'false';
    const icon = soundOn ? '🔊' : '🔇';
    btn.innerHTML = `<span class="snd-dot"></span><span class="btn-sound-icon">${icon}</span><span class="btn-sound-label">${soundOn ? 'Sound on' : 'Sound off'}</span>`;
  };
  render();
  btn.addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem(SOUND_PREF_KEY, soundOn ? '1' : '0');
    render();
    if (soundOn && 'speechSynthesis' in window) {
      unlockSpeechFromGesture();
      const utter = new SpeechSynthesisUtterance('Sound on');
      const voice = pickVoice();
      if (voice) utter.voice = voice;
      speakOrQueue(utter, true);
    } else if (!soundOn) {
      pendingSpeech.length = 0;
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }
  });
}

/* ------------------------------------------------------------------
 * Date/time display — every timestamp stored in the database and
 * returned by the API (created_at, started_at, ended_at, joined_at,
 * claimed_at, ...) is UTC with no zone info, e.g. "2026-08-09 14:05:32".
 * These helpers are the single place that turns that into the viewer's
 * own local date/time, so hosts, players, and admins each see times in
 * their own time zone rather than the server's. Always go through these
 * instead of displaying a raw timestamp string.
 * ---------------------------------------------------------------- */

/** Parses a "YYYY-MM-DD HH:MM:SS" UTC timestamp (as returned by the API)
 *  into a real Date. Returns null for empty/invalid input. */
function parseUtcTimestamp(utcString) {
  if (!utcString) return null;
  // MySQL DATETIME round-trips as a plain "YYYY-MM-DD HH:MM:SS" string
  // with no zone info — treat it as UTC explicitly (the "Z" suffix)
  // rather than letting the browser assume it's already local.
  const iso = String(utcString).replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Formats a UTC timestamp string as the viewer's local date + time,
 *  e.g. "Aug 9, 2026, 7:35 PM". Returns a dash for empty/invalid input. */
function formatLocalDateTime(utcString) {
  const d = parseUtcTimestamp(utcString);
  if (!d) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/** Winner claim time in local HH:MM:SS format, e.g. 12:57:54. */
function formatLocalTimeSeconds(utcString) {
  const d = parseUtcTimestamp(utcString);
  if (!d) return '—';
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

/** Formats just the local time portion, e.g. "7:35 PM". */
function formatLocalTime(utcString) {
  const d = parseUtcTimestamp(utcString);
  if (!d) return '—';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Compact local date + time for the Game Details "Started"/"Completed"
 *  rows only, e.g. "Aug 9, 7:35 PM". Two things vs formatLocalDateTime:
 *  - hour12 is forced on, so the AM/PM marker always renders even on a
 *    browser/OS locale whose default hour cycle would otherwise omit it
 *    (that's why it could go missing entirely on some machines).
 *  - the year is dropped, since this card is always about a room that
 *    just ran — that's what keeps the value short enough to stay on one
 *    line in the fixed-width host sidebar and the player card. */
function formatGameDetailsDateTime(utcString) {
  const d = parseUtcTimestamp(utcString);
  if (!d) return '—';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/** Human-readable elapsed time between two UTC timestamp strings, e.g.
 *  "12m 34s" or "1h 4m 2s". Returns a dash if either end is missing. */
function formatDuration(startUtc, endUtc) {
  const start = parseUtcTimestamp(startUtc);
  const end = parseUtcTimestamp(endUtc);
  if (!start || !end) return '—';
  // Subtract the 5s start countdown, same as the Game Details "Time taken"
  // field in renderGameDetails() below — otherwise the history list and
  // the room's own Game Details card disagree by exactly 5 seconds.
  return formatDurationSeconds(Math.max(0, Math.round((end - start) / 1000)));
}

/** Same "Xh Ym Zs" style as formatDuration, but from a raw seconds count —
 *  used to render the Game Details "Time taken" field from the exact same
 *  tick-by-tick counter that drives the nav-bar mm:ss timer (see
 *  GAME_START_COUNTDOWN_MS / syncGameDetailsDuration below), so the two
 *  never drift apart or disagree by the countdown offset. */
function formatDurationSeconds(totalSeconds) {
  let secs = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(secs / 3600); secs -= h * 3600;
  const m = Math.floor(secs / 60); secs -= m * 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

// Matches GameEngine::START_COUNTDOWN_SECONDS and the identical constant in
// page-host.js/page-player.js — the server holds the first number call back
// for this long, and the nav-bar timer starts counting from "GO!" rather
// than from the moment Start Game was clicked. Applied here too so a
// *completed* game's "Time taken" lines up with what the nav timer showed
// while it was running, instead of reading ~5s higher.
const GAME_START_COUNTDOWN_MS = 0;

/** Fills in the #gameDetailsCard (start time / completed time / time
 *  taken, all converted to the viewer's own local time zone) from a
 *  results.php `room` object, and reveals the card once the game has
 *  actually started — there's nothing useful to show before that,
 *  whether this is a live game in progress or one opened from history.
 *  For a still-running game, pass `liveElapsedSeconds` (the same counter
 *  driving the nav-bar timer) so "Time taken" ticks in lockstep with it
 *  instead of being recomputed independently against `new Date()`. */
function renderGameDetails(room, liveElapsedSeconds) {
  const card = document.getElementById('gameDetailsCard');
  if (!card || !room) return;
  if (!room.started_at) {
    card.classList.add('d-none');
    return;
  }
  card.classList.remove('d-none');
  document.getElementById('gdStartTime').textContent = formatGameDetailsDateTime(room.started_at);
  document.getElementById('gdEndTime').textContent = room.ended_at
    ? formatGameDetailsDateTime(room.ended_at)
    : 'In progress';

  const gdEndEl = document.getElementById('gdEndTime');
  if (gdEndEl) gdEndEl.classList.toggle('gd-live', !room.ended_at);

  if (room.ended_at) {
    const start = parseUtcTimestamp(room.started_at);
    const end = parseUtcTimestamp(room.ended_at);
    const secs = (start && end) ? Math.max(0, Math.round((end - start) / 1000)) : null;
    document.getElementById('gdDuration').textContent = secs !== null ? formatDurationSeconds(secs) : '—';
  } else if (typeof liveElapsedSeconds === 'number') {
    document.getElementById('gdDuration').textContent = formatDurationSeconds(liveElapsedSeconds);
  } else {
    const start = parseUtcTimestamp(room.started_at);
    const secs = start ? Math.max(0, Math.round((Date.now() - start) / 1000)) : null;
    document.getElementById('gdDuration').textContent = secs !== null ? formatDurationSeconds(secs) : '—';
  }
}

/** Pushes the same elapsed-seconds counter that drives the nav-bar timer
 *  straight into the Game Details "Time taken" field, once a second, while
 *  the game is RUNNING — called from the same setInterval tick as the
 *  nav-bar timer in page-host.js/page-player.js so both numbers can never
 *  disagree. No-op if the card isn't visible (e.g. history view). */
function syncGameDetailsDuration(elapsedSeconds) {
  const card = document.getElementById('gameDetailsCard');
  if (!card || card.classList.contains('d-none')) return;
  const el = document.getElementById('gdDuration');
  if (el) el.textContent = formatDurationSeconds(elapsedSeconds);
}

function getStoredIdentity() {
  try {
    return JSON.parse(localStorage.getItem('housiy_identity') || 'null');
  } catch { return null; }
}
function setStoredIdentity(name, email) {
  localStorage.setItem('housiy_identity', JSON.stringify({ name, email }));
}

// ---------------------------------------------------------------------
// Realtime updates: one room-scoped persistent WebSocket per page session.
// REST remains the canonical snapshot/recovery path; snapshots are fetched on
// initial load, reconnect, sequence gaps and relevant pushed events only.
// No timer-based ticket/results polling is used while the room is active.
// ---------------------------------------------------------------------
let rtConnected = false;
let rtLastRoomVersion = null; // last committed room-wide version observed on this socket
let rtPollFn = null;
let rtCountdownTimer = null;
let rtAutoCall = null; // { secs, at } from the latest server response
let rtStopSocketReconnect = null;
let rtMaybeConnectSocket = null;

/** Let independent widgets (e.g. emoji reactions) react to a server signal. */
function rtAnnounce(type, reaction = null) {
  try { window.dispatchEvent(new CustomEvent('housiy:realtime', { detail: { type: String(type || ''), ...(reaction ? { reaction } : {}) } })); } catch (_) { /* no DOM events in this environment */ }
}

/** Start WebSocket-first room updates with HTTP snapshot polling only during socket outages. */
function startRealtime(roomCode, pollFn) {
  // All page features share this single room-scoped connection manager.
  if (window.housiyRealtimeManagerActive) {
    console.warn('[Housiy realtime] duplicate manager start ignored', { room: roomCode });
    return null;
  }
  window.housiyRealtimeManagerActive = true;
  rtPollFn = pollFn;
  let timer = null, ws = null, hbMs = 10000, attempt = 0, retryTimer = null, connectGuardTimer = null;
  let inflight = false, inflightPromise = null, pending = false, socketStopped = false, socketEligible = false, realtimeTerminal = false, refreshDebounceTimer = null;
  let recoveryInProgress = false, recoverySocket = null;
  const recoveryEventQueue = [];
  const FALLBACK_POLL_MS = 1500;
  let fallbackActive = false;
  // Outage ramp: HTTP fallback starts at FALLBACK_POLL_MS and relaxes the longer
  // the socket stays down, so a gateway outage cannot saturate PHP-FPM.
  let fallbackSince = 0, fallbackTicks = 0;
  const fallbackStride = () => {
    const outageMs = fallbackSince ? Date.now() - fallbackSince : 0;
    return outageMs < 20000 ? 1 : 2; // 1.5s, then 3s: never slower than the fastest auto-call pace
  };
  let lastEventAt = Date.now();
  const commandWaiters = new Map();
  const seenEventIds = new Set();
  window.housiyRealtimeSend = (event, data = {}) => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('Realtime connection is not ready'));
    const command_id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`;
    const timeout = setTimeout(() => { commandWaiters.delete(command_id); reject(new Error('Realtime command timed out')); }, 12000);
    commandWaiters.set(command_id, {resolve, reject, timeout});
    try { ws.send(JSON.stringify({event, command_id, room_code:roomCode, data})); } catch (e) { clearTimeout(timeout); commandWaiters.delete(command_id); reject(e); }
  });

  const setPolling = (ms) => {
    if (timer) { clearInterval(timer); timer = null; }
    if (ms > 0 && !realtimeTerminal && !socketStopped && !document.hidden) {
      timer = setInterval(() => {
        if (rtConnected || realtimeTerminal || document.hidden) return;
        fallbackTicks++;
        if (fallbackTicks % fallbackStride() !== 0) return;
        refreshNow();
      }, ms);
    }
  };
  const stopPolling = () => { realtimeTerminal = true; fallbackActive = false; if (timer) { clearInterval(timer); timer = null; } pending = false; };
  const enterFallback = (reason) => {
    if (realtimeTerminal || socketStopped || rtConnected || document.hidden) return;
    const firstEntry = !fallbackActive;
    fallbackActive = true;
    if (firstEntry) { fallbackSince = Date.now(); fallbackTicks = 0; }
    setPolling(FALLBACK_POLL_MS);
    if (firstEntry) {
      console.warn('[Housiy realtime] HTTP fallback enabled', { reason, room: roomCode, interval_ms: FALLBACK_POLL_MS });
      rtAnnounce('fallback');
      refreshNow();
    }
  };
  const leaveFallback = () => {
    fallbackActive = false;
    fallbackSince = 0; fallbackTicks = 0;
    if (timer) { clearInterval(timer); timer = null; }
    rtAnnounce('connected');
  };
  window.housiySetRealtimePollInterval = setPolling;
  window.housiyStopRealtimePolling = stopPolling;
  const stopSocketReconnect = () => {
    if (socketStopped) return;
    socketStopped = true;
    stopPolling();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (connectGuardTimer) { clearTimeout(connectGuardTimer); connectGuardTimer = null; }
    if (refreshDebounceTimer) { clearTimeout(refreshDebounceTimer); refreshDebounceTimer = null; }
    if (ws) {
      // Detach close/error callbacks before closing so a completed game cannot
      // schedule another connection from the socket's close event.
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { if (ws.readyState < WebSocket.CLOSING) ws.close(1000, 'game completed'); } catch (_) {}
    }
    ws = null;
    rtConnected = false;
    if (window.housiyRealtimeSend) window.housiyRealtimeSend = null;
    rtAutoCall = null;
    if (rtCountdownTimer) { clearTimeout(rtCountdownTimer); rtCountdownTimer = null; }
  };
  rtStopSocketReconnect = stopSocketReconnect;
  window.housiyStopRealtimeRoom = (reason = 'left room') => {
    socketStopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (connectGuardTimer) { clearTimeout(connectGuardTimer); connectGuardTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
    if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close(1000, String(reason).slice(0, 120)); } catch (_) {} }
    ws = null; rtConnected = false; fallbackActive = false;
    if (window.housiyRealtimeSend) window.housiyRealtimeSend = null;
    rtAnnounce('left_room');
  };
  const refreshNow = async () => {
    if (realtimeTerminal || socketStopped) return null;
    if (inflight) { pending = true; return inflightPromise; }
    inflight = true;
    inflightPromise = (async () => {
      let result = null;
      try { result = await pollFn(); } catch (_) { /* next signal/heartbeat retries */ }
      inflight = false;
      inflightPromise = null;
      if (pending) { pending = false; scheduleRefresh(); }
      return result;
    })();
    return inflightPromise;
  };
  // Coalesce bursts (e.g. mark + claim + room signals) into one refresh. The
  // browser still fetches the canonical API payload, but avoids back-to-back
  // duplicate ticket/results requests when several signals arrive together.
  const scheduleRefresh = () => {
    if (realtimeTerminal || socketStopped || refreshDebounceTimer) return;
    refreshDebounceTimer = setTimeout(() => {
      refreshDebounceTimer = null;
      refreshNow();
    }, 80);
  };
  const refresh = () => scheduleRefresh();
  const fallback = (reason) => {
    if (realtimeTerminal || socketStopped) return;
    if (rtConnected) rtConnected = false;
    enterFallback(reason || 'socket unavailable');
  };
  const scheduleReconnect = () => {
    if (realtimeTerminal || socketStopped || !socketEligible || retryTimer) return;
    // Cap at 10s (was 30s): a failed handshake is answered by nginx alone (no PHP), so
    // frequent retries are cheap and the socket returns quickly after a gateway restart.
    const delay = Math.min(10000, 1000 * Math.pow(2, attempt++)) * (0.7 + Math.random() * 0.6);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };
  function connect() {
    if (realtimeTerminal || socketStopped || !socketEligible || (ws && ws.readyState <= 1)) return;
    if (!('WebSocket' in window)) { fallback('websocket unsupported by browser'); return; }
    let socket;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(roomCode)}`);
      ws = socket;
      // A socket can remain CONNECTING indefinitely when a proxy silently drops
      // the upgrade. Do not leave the player without updates while that happens.
      connectGuardTimer = setTimeout(() => {
        connectGuardTimer = null;
        if (ws === socket && socket.readyState === WebSocket.CONNECTING) {
          fallback('websocket handshake timeout');
          try { socket.close(); } catch (_) {}
        }
      }, 8000);
    } catch (_) { fallback('websocket constructor failed'); scheduleReconnect(); return; }
    socket.onopen = () => {
      if (ws !== socket) return;
      if (connectGuardTimer) clearTimeout(connectGuardTimer);
      // Upgrade succeeded, but the authenticated room HELLO must also arrive.
      connectGuardTimer = setTimeout(() => {
        connectGuardTimer = null;
        if (ws === socket && socket.readyState === WebSocket.OPEN && !rtConnected) {
          fallback('room authentication/hello timeout');
          try { socket.close(); } catch (_) {}
        }
      }, 8000);
    };
    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      lastEventAt = Date.now();
      // Reject any cross-room envelope even if an upstream publisher is buggy.
      if (m.room_code && String(m.room_code).trim().toUpperCase() !== String(roomCode).trim().toUpperCase()) {
        console.error('[Housiy realtime] ignored cross-room event', { expected: roomCode, received: m.room_code });
        return;
      }
      // Administrative lifecycle events must be handled before snapshot
      // recovery buffering: the blocked user's HTTP session is revoked in the
      // same transaction, so waiting for a successful snapshot would strand
      // the kick event in the recovery queue.
      if (m.event === 'PLAYER_BLOCKED') {
        try { if (window.housiyStopRealtimeRoom) window.housiyStopRealtimeRoom('blocked by administrator'); } catch (_) {}
        window.location.replace('index.html?notice=player_blocked&rejoin=' + encodeURIComponent(roomCode));
        return;
      }
      if (m.event === 'ROOM_DELETED') {
        try { if (window.housiyStopRealtimeRoom) window.housiyStopRealtimeRoom('room deleted'); } catch (_) {}
        const notice = m.data?.reason === 'admin' ? 'admin_room_deleted' : 'room_deleted';
        window.location.replace('index.html?notice=' + notice);
        return;
      }
      if (m.event === 'PLAYER_REMOVED') {
        // Roster count and participant list are derived from active members.
        // Advance the sequence baseline and reconcile on every room page.
        const removedSequence = Number(m.sequence || 0);
        if (removedSequence > 0) rtLastRoomVersion = Math.max(rtLastRoomVersion || 0, removedSequence);
        if (m.event_id && ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({event:'ACK_EVENT', command_id:`ack-${String(m.event_id).slice(0,64)}`, room_code:roomCode, data:{event_id:String(m.event_id), sequence:removedSequence}})); } catch (_) {}
        }
        refresh();
        rtAnnounce('player_removed', m.data || null);
        return;
      }
      // Buffer room traffic received between HELLO and successful snapshot
      // reconciliation. Buffer before event-id dedupe so replay can process it.
      if (recoveryInProgress && recoverySocket === socket && !(m.t === 'hello' || m.event === 'HELLO')) {
        if (recoveryEventQueue.length < 500) recoveryEventQueue.push(m);
        else { console.warn('[Housiy realtime] recovery event buffer full; forcing snapshot retry', {room: roomCode}); fallback('recovery event buffer full'); }
        return;
      }
      if (m.event_id && seenEventIds.has(String(m.event_id))) return;
      if (m.event_id) { seenEventIds.add(String(m.event_id)); if (seenEventIds.size > 1000) seenEventIds.delete(seenEventIds.values().next().value); }
      if (m.event === 'COMMAND_RESULT' || m.event === 'MARK_REJECTED' || m.event === 'ERROR' || (m.command_id && commandWaiters.has(m.command_id))) {
        const waiter = commandWaiters.get(m.command_id);
        if (m.event === 'ROOM_STATE_SYNC') refresh();
        if (waiter) { clearTimeout(waiter.timeout); commandWaiters.delete(m.command_id); if (m.event === 'ERROR') waiter.reject(new Error(m.data?.message || 'Realtime command failed')); else waiter.resolve(m.data?.response || m.data || {}); }
        return;
      }
      if (m.t === 'hello' || m.event === 'HELLO') {
        if (recoveryInProgress && recoverySocket === socket) return;
        recoveryInProgress = true;
        recoverySocket = socket;
        attempt = 0;
        if (connectGuardTimer) { clearTimeout(connectGuardTimer); connectGuardTimer = null; }
        // HELLO carries the Redis room sequence baseline. A fresh canonical
        // snapshot follows immediately, so reconnects reconcile state before
        // relying on subsequent contiguous events.
        const helloSequence = Number.isSafeInteger(Number(m.sequence)) && Number(m.sequence) >= 0 ? Number(m.sequence) : 0;
        rtLastRoomVersion = helloSequence;
        if (m.hb > 0) hbMs = m.hb;
        // Keep fallback active until the canonical REST snapshot has loaded and
        // rendered successfully. A successful WS handshake/HELLO alone is not
        // sufficient to declare recovery complete.
        void (async () => {
          const snapshot = await refreshNow();
          const validSnapshot = !!(snapshot && snapshot.success === true);
          if (ws !== socket || socket.readyState !== WebSocket.OPEN || recoverySocket !== socket) return;
          if (!validSnapshot) {
            console.warn('[Housiy realtime] snapshot reconciliation failed; keeping HTTP fallback', { room: roomCode });
            recoveryInProgress = false; recoverySocket = null;
            fallback('snapshot reconciliation failed');
            try { socket.close(1011, 'snapshot reconciliation failed'); } catch (_) {}
            return;
          }
          rtConnected = true;
          recoveryInProgress = false; recoverySocket = null;
          leaveFallback();
          rtAnnounce('hello');
          const queued = recoveryEventQueue.splice(0);
          for (const queuedMessage of queued) {
            if (ws !== socket || socket.readyState !== WebSocket.OPEN) break;
            socket.onmessage({ data: JSON.stringify(queuedMessage) });
          }
        })();
      } else if (m.event) {
        // A completed game is still a room participant, but it is no longer a
        // live-game subscriber. Keep only room/rematch lifecycle traffic on the
        // existing socket. ROOM_STATE_SYNC is the gateway envelope for
        // rematch_created; GAME_STARTED transitions the accepted rematch back
        // into the normal live event stream. Do not ACK or dispatch stale game
        // events (numbers, marks, reactions, etc.) while waiting for rematch.
        const terminalAllowedEvents = new Set(['ROOM_STATE_SYNC', 'GAME_STARTED', 'GAME_FINISHED', 'WINNER_DECLARED', 'PRIZE_CLAIMED', 'PLAYER_REMOVED']);
        const reactionGraceActive = Number(window.housiyReactionGraceUntil || 0) > Date.now();
        if (window.housiyGameTerminal && !terminalAllowedEvents.has(m.event) && !(m.event === 'EMOJI_REACTION' && reactionGraceActive)) return;
        if (m.event_id && ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({event:'ACK_EVENT', command_id:`ack-${String(m.event_id).slice(0,64)}`, room_code:roomCode, data:{event_id:String(m.event_id), sequence:Number(m.sequence || 0)}})); } catch (_) {} }
        const legacyType = ({NUMBER_CALLED:'number_called', NUMBER_MARKED:'ticket_marked', WINNER_DECLARED:'prize_won', PRIZE_CLAIMED:'prize_won', GAME_STARTED:'game_started', GAME_PAUSED:'game_paused', GAME_RESUMED:'game_resumed', GAME_FINISHED:'game_ended', PLAYER_JOINED:'player_joined', PLAYER_REMOVED:'player_removed', EMOJI_REACTION:'reaction'}[m.event] || m.event.toLowerCase());
        if (m.event === 'GAME_FINISHED') { window.housiyGameTerminal = true; window.housiyReactionGraceUntil = Date.now() + 10000; rtAutoCall = null; }
        if (m.event === 'GAME_STARTED') { window.housiyGameTerminal = false; resetRoomWinnerAnnouncements(); }
        if (m.event === 'ROOM_STATE_SYNC') refresh();
        rtAnnounce(legacyType, m.data || null);
        if (m.event === 'NUMBER_CALLED') {
          const interval = Number(m.data?.auto_call_interval_seconds || 0);
          rtAutoCall = m.data?.auto_call_enabled && interval > 0
            ? { secs: interval, at: Date.now() }
            : null;
        }
        const version = Number(m.sequence || 0);
        if (version > 0) {
          if (rtLastRoomVersion !== null && version <= rtLastRoomVersion) { console.warn('[Housiy realtime] out-of-order room event; reconciling snapshot', {previous:rtLastRoomVersion,current:version,room:roomCode}); refresh(); }
          if (rtLastRoomVersion !== null && version > rtLastRoomVersion + 1) { console.warn('[Housiy realtime] event sequence gap; requesting snapshot', {previous:rtLastRoomVersion,current:version,room:roomCode}); refresh(); }
          rtLastRoomVersion = Math.max(rtLastRoomVersion || 0, version);
        }
        // Normal game events are applied directly by the page controllers.
        // Fetch a canonical snapshot only for explicit sync requests, sequence
        // gaps/out-of-order delivery, or lifecycle/roster changes that need
        // fields not carried by the event envelope. Number calls and marks do
        // not generate ticket.php/results.php requests.
        if (['GAME_STARTED','GAME_PAUSED','GAME_RESUMED','GAME_FINISHED','PLAYER_JOINED','PLAYER_REMOVED'].includes(m.event)) refresh();
      } else if (m.t === 'u') {
        // Compact legacy signals carry no rematch lifecycle semantics. Ignore
        // them while terminal; ROOM_STATE_SYNC uses the modern event envelope.
        if (window.housiyGameTerminal) return;
        const version = Number(m.v);
        if (Number.isSafeInteger(version) && version > 0) {
          // Pub/Sub is at-most-once. A version gap means a signal was missed;
          // refresh the canonical snapshot rather than trying to replay events.
          if (rtLastRoomVersion !== null && version > rtLastRoomVersion + 1) {
            console.warn('[Housiy realtime] room event gap; reconciling snapshot', {
              previous: rtLastRoomVersion, current: version, room: roomCode,
            });
            refresh();
          } else if (rtLastRoomVersion !== null && version <= rtLastRoomVersion) {
            console.warn('[Housiy realtime] stale/out-of-order compact event ignored', { previous: rtLastRoomVersion, current: version, room: roomCode });
            refresh();
            return;
          }
          rtLastRoomVersion = Math.max(rtLastRoomVersion || 0, version);
        }
        rtAnnounce(m.e, m.r || null);
        if (m.e === 'number_called') {
          const interval = Number(m.data?.auto_call_interval_seconds || 0);
          rtAutoCall = m.data?.auto_call_enabled && interval > 0
            ? { secs: interval, at: Date.now() }
            : null;
        }
        // Legacy compact signals are not sufficient to update the full UI.
        // Reconcile only for non-reaction signals; modern event envelopes are
        // handled above without per-number/per-mark HTTP snapshots.
        if (m.e !== 'reaction' && !['number_called','ticket_marked','ticket_updated'].includes(m.e)) refresh();
      }
    };
    socket.onclose = (event) => {
      if (ws !== socket || socketStopped) return;
      // Keep the failure reason visible in DevTools; a generic browser error
      // hides whether the proxy returned 401/403/429/503 or dropped the upgrade.
      console.warn('[Housiy realtime] WebSocket closed', { code: event?.code, reason: event?.reason || '', room: roomCode });
      fallback('websocket closed');
      for (const [id, waiter] of commandWaiters) { clearTimeout(waiter.timeout); waiter.reject(new Error('Realtime connection closed')); commandWaiters.delete(id); }
      scheduleReconnect();
    };
    socket.onerror = (event) => {
      if (ws === socket && !socketStopped) {
        fallback('websocket error');
        // `proto` is local to connect(); use the actual socket URL here.
        // Referencing `proto` from this callback caused a second ReferenceError
        // that hid the original WebSocket handshake failure in the browser.
        console.warn('[Housiy realtime] WebSocket connection error', {
          url: ws && ws.url ? ws.url : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
          room: roomCode,
          readyState: ws ? ws.readyState : null,
          eventType: event && event.type ? event.type : 'error'
        });
        try { if (socket.readyState < WebSocket.CLOSING) socket.close(); } catch (_) {}
      }
    };
  }
  rtMaybeConnectSocket = () => {
    if (socketStopped) return;
    socketEligible = true;
    // While a backoff timer is pending, scheduleReconnect() owns the next attempt.
    // Poll responses call this on every fallback tick; without the guard they
    // would bypass the exponential backoff and hammer /ws every poll.
    if (!document.hidden && !retryTimer && (!ws || ws.readyState > 1)) connect();
  };
  // Stall watchdog: while a game is auto-calling, events normally arrive every few
  // seconds. If a healthy socket stays silent (worker down, lost publish) take one
  // canonical snapshot instead of waiting for a later event to expose a gap.
  setInterval(() => {
    if (realtimeTerminal || socketStopped || !rtConnected || document.hidden || window.housiyGameTerminal || !rtAutoCall) return;
    if (Date.now() - lastEventAt < 20000) return;
    lastEventAt = Date.now();
    refreshNow();
  }, Math.max(5000, hbMs));
  document.addEventListener('visibilitychange', () => {
    if (!socketStopped && socketEligible && !document.hidden && (!ws || ws.readyState > 1)) { attempt = 0; connect(); }
    else if (!document.hidden && !rtConnected && fallbackActive) { setPolling(FALLBACK_POLL_MS); refreshNow(); }
  });

  // Completed rooms keep the room-scoped socket for rematch lifecycle events.
  // Cached terminal state disables game actions, not room connectivity.
  Promise.resolve(typeof housiyHasCachedTerminalState === 'function' ? housiyHasCachedTerminalState(roomCode) : false)
    .then((cachedTerminal) => {
      if (cachedTerminal) { window.housiyGameTerminal = true; rtAnnounce('terminal'); }
      if (!realtimeTerminal && !socketStopped) { socketEligible = true; connect(); }
    })
    .catch(() => { if (!realtimeTerminal && !socketStopped) { socketEligible = true; connect(); } });
  return timer;
}

/** Call from a canonical snapshot render path. The start countdown and
 *  subsequent number calls are delivered by room events; do not schedule an
 *  extra HTTP read when the local countdown expires. */
function rtAfterResponse(res) {
  if (!res) return;
  const gameStatus = res.game && String(res.game.status || '').toUpperCase();
  const roomStatus = res.room && String(res.room.status || '').toUpperCase();
  const terminal = ['ENDED', 'COMPLETED'].includes(gameStatus) || roomStatus === 'COMPLETED';
  const lobby = ['LOBBY', 'WAITING', 'NOT_STARTED', ''].includes(roomStatus) && !['RUNNING', 'PAUSED'].includes(gameStatus);
  if (terminal && rtMaybeConnectSocket) {
    const firstTerminalSignal = !window.housiyGameTerminal;
    window.housiyGameTerminal = true;
    // A completed GAME is not a completed ROOM. Keep the authenticated room
    // socket alive for REMATCH_CREATED and other lifecycle events. HTTP polling
    // remains available only if this socket subsequently disconnects.
    if (firstTerminalSignal) {
      const endedAtRaw = res.room && res.room.ended_at || res.game && res.game.ended_at;
      const endedAtMs = endedAtRaw ? Date.parse(String(endedAtRaw).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(endedAtRaw)) ? '' : 'Z')) : NaN;
      window.housiyReactionGraceUntil = Number.isFinite(endedAtMs) ? endedAtMs + 10000 : Date.now() + 10000;
      rtAnnounce('terminal');
      housiySaveFinalSnapshot(res.room && (res.room.room_code || res.room.code) || new URLSearchParams(location.search).get('room'));
    }
    rtMaybeConnectSocket();
  } else if ((lobby || ['LIVE', 'PAUSED', 'RUNNING'].includes(roomStatus) || ['RUNNING', 'PAUSED'].includes(gameStatus)) && rtMaybeConnectSocket) {
    // Keep the room socket connected in the lobby as well as during gameplay.
    // The socket carries room events; REST snapshots are only used to reconcile
    // complete UI state after reconnects or relevant changes.
    rtMaybeConnectSocket();
  }
  if (!res.game) return;
  const secs = res.room ? res.room.auto_call_seconds_remaining : null;
  rtAutoCall = (secs !== null && secs !== undefined) ? { secs, at: Date.now() } : null;
}

// While live, keep the "(Ns)" auto-call badge counting down between
// signals, exactly as the 1s polling used to.
setInterval(() => {
  if (window.housiyGameTerminal || !rtAutoCall) return;
  const el = document.getElementById('autoCallSeconds');
  if (!el || !/^\(\d+s\)$/.test(el.textContent)) return;
  const left = Math.max(0, rtAutoCall.secs - Math.floor((Date.now() - rtAutoCall.at) / 1000));
  el.textContent = `(${left}s)`;
}, 1000);
