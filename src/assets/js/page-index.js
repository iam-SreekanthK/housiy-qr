// Declare history state before the first-page auto-load below. Calling a
// function that closes over let bindings before initialization triggers the
// temporal-dead-zone ReferenceError and silently prevents history from loading.
let historyLoaded = false;
let historyLoadPromise = null;

const identity = getStoredIdentity();
if (identity) {
  document.getElementById('nameInput').value = identity.name;
  document.getElementById('emailInput').value = identity.email;
}

try {
  if (localStorage.getItem('housiy_authenticated') === '1') {
    loadHistory().then(result => {
      if (!result?.success && !/authenticat|session|log.?in|unauthori[sz]ed/i.test(String(result?.error || ''))) {
        console.warn('[Housiy] Game history could not be loaded:', result?.error || 'unknown error');
      }
    }).catch(error => console.warn('[Housiy] Game history could not be loaded:', error));
  }
} catch (_) { /* storage disabled: keep history hidden and avoid an auth guess */ }

// A landing page can be restored from the back/forward cache without running
// its scripts again. Re-check the explicit authenticated marker on restore.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  try {
    if (localStorage.getItem('housiy_authenticated') === '1') {
      loadHistory().catch(error => console.warn('[Housiy] Game history could not be loaded:', error));
    }
  } catch (_) { /* storage disabled: do not infer authentication */ }
});

document.querySelectorAll('#modeTabs .nav-link').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#modeTabs .nav-link').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.mode;
    document.getElementById('joinPane').classList.toggle('d-none', mode !== 'join');
    document.getElementById('hostPane').classList.toggle('d-none', mode !== 'host');
    // Mobile only (see .landing-main.mode-host in style.css): Join stays
    // vertically centered, Host a Room reverts to top-aligned since its
    // taller expanded content needs the original scroll-safe behavior.
    document.querySelector('.landing-main').classList.toggle('mode-host', mode === 'host');
    // Host a Room expands the card taller than a phone screen — scroll
    // back to the top so the whole card (title, prizes, Create Room)
    // starts from a known, fully-reachable position instead of wherever
    // the page happened to be scrolled to.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

function getIdentityInputs() {
  const name = document.getElementById('nameInput').value.trim();
  const email = document.getElementById('emailInput').value.trim();
  const errEl = document.getElementById('identityError');
  if (!name || !email) {
    errEl.textContent = 'Please enter both your name and email.';
    return null;
  }
  errEl.textContent = '';
  return { name, email };
}

/** Joins `roomCode` as `ident` and, on success, opens the player page.
 *  Shared by the Join button and the QR-invite auto-join. Returns true when
 *  the join succeeded (the page is then navigating away). */
async function joinRoomAndEnter(ident, roomCode) {
  const btn = document.getElementById('joinBtn');
  btn.disabled = true; btn.textContent = 'Joining...';
  const res = await apiPost('room_join.php', { name: ident.name, email: ident.email, room_code: roomCode });
  btn.disabled = false; btn.textContent = 'Join Room';
  if (!res.success) { showToast(res.error || 'Failed to join', 'danger'); return false; }
  setStoredIdentity(ident.name, ident.email);
  // room_join.php has established the authenticated server session. This
  // marker only gates the landing-page history request; cached identity alone
  // must never trigger an unauthenticated history call.
  try { localStorage.setItem('housiy_authenticated', '1'); } catch (_) {}
  window.location.href = `player.html?room=${res.room.room_code}`;
  return true;
}

document.getElementById('joinBtn').addEventListener('click', async () => {
  const ident = getIdentityInputs();
  if (!ident) return;
  const roomCode = document.getElementById('roomCodeInput').value.trim().toUpperCase();
  if (!roomCode) { showToast('Enter a Room ID', 'danger'); return; }
  await joinRoomAndEnter(ident, roomCode);
});

// --- Join by QR code / invite link: index.html?room=<ROOM_CODE> ----------
// The host's QR encodes this link. Scanning it lands here with the Room ID
// pre-filled:
//   * already signed in on this device -> join automatically (with a short
//     "Not you?" escape so a shared device can switch identity);
//   * otherwise -> ask for name + email, then the normal Join Room flow runs.
(function handleInviteLink() {
  const raw = new URLSearchParams(window.location.search).get('room');
  if (raw === null) return;
  const inviteCode = raw.trim().toUpperCase();
  // Drop ?room= from the address bar right away so Back from the player page
  // (or a reload) can never re-trigger an automatic join.
  try {
    const clean = new URL(window.location.href);
    clean.searchParams.delete('room');
    history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
  } catch (_) { /* non-critical */ }
  if (!/^[A-Z0-9]{3,32}$/.test(inviteCode)) return; // malformed link: plain landing page

  const roomInput = document.getElementById('roomCodeInput');
  const nameInput = document.getElementById('nameInput');
  const emailInput = document.getElementById('emailInput');
  const banner = document.getElementById('inviteBanner');
  const bannerText = document.getElementById('inviteBannerText');
  const notYouBtn = document.getElementById('inviteNotYouBtn');
  roomInput.value = inviteCode;
  // The Join tab is the default; make sure it is the one showing.
  document.querySelector('#modeTabs .nav-link[data-mode="join"]')?.click();
  window.scrollTo({ top: 0 });

  let authenticated = false;
  try { authenticated = localStorage.getItem('housiy_authenticated') === '1'; } catch (_) {}
  const stored = getStoredIdentity();
  const hasIdentity = !!(stored && stored.name && stored.email);

  banner.classList.remove('d-none');
  // Enter submits while an invite is open (landing page had no Enter handling).
  [nameInput, emailInput, roomInput].forEach(el => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('joinBtn').click(); }
  }));

  if (authenticated && hasIdentity) {
    let cancelled = false;
    bannerText.textContent = `Joining room ${inviteCode} as ${stored.name}…`;
    notYouBtn.classList.remove('d-none');
    const timer = setTimeout(async () => {
      if (cancelled) return;
      notYouBtn.classList.add('d-none');
      const ok = await joinRoomAndEnter({ name: stored.name, email: stored.email }, inviteCode);
      if (!ok) {
        // Room full / already started / not found: leave the form usable and say why.
        bannerText.textContent = `Couldn't join room ${inviteCode}. Check the details below and try again.`;
      }
    }, 1200);
    notYouBtn.addEventListener('click', () => {
      cancelled = true;
      clearTimeout(timer);
      notYouBtn.classList.add('d-none');
      nameInput.value = ''; emailInput.value = '';
      bannerText.textContent = `You're invited to join room ${inviteCode}. Enter your name and email to continue.`;
      nameInput.focus();
    });
  } else {
    bannerText.textContent = `You're invited to join room ${inviteCode}. Enter your name and email to continue.`;
    if (hasIdentity) { // remembered details but no confirmed session: prefilled, one tap to join
      bannerText.textContent = `You're invited to join room ${inviteCode}. Check your details and tap Join Room.`;
    } else {
      nameInput.focus();
    }
  }
})();

document.getElementById('autoCallToggle').addEventListener('change', (e) => {
  document.getElementById('autoCallIntervalWrap').classList.toggle('d-none', !e.target.checked);
  document.getElementById('autoCallOffHint').classList.toggle('d-none', e.target.checked);
});

// Full House winners (1-5): the box only applies while Full House is ticked.
const fullHouseCheck = document.getElementById('fullHouseCheck');
const fullHouseWinnersInput = document.getElementById('fullHouseWinnersInput');
const fullHouseWinnersHint = document.getElementById('fullHouseWinnersHint');
function clampFullHouseWinners() {
  let n = parseInt(fullHouseWinnersInput.value, 10);
  if (!Number.isFinite(n)) n = 1;
  n = Math.min(5, Math.max(1, n));
  fullHouseWinnersInput.value = String(n);
  fullHouseWinnersHint.textContent = n === 1 ? 'winner' : 'winners';
  return n;
}
function syncFullHouseWinnersState() {
  fullHouseWinnersInput.disabled = !fullHouseCheck.checked;
  fullHouseWinnersInput.classList.toggle('opacity-50', !fullHouseCheck.checked);
  fullHouseWinnersHint.classList.toggle('opacity-50', !fullHouseCheck.checked);
}
fullHouseWinnersInput.addEventListener('input', () => {
  // Let the host clear the box while typing; fix it on blur/change/submit.
  const n = parseInt(fullHouseWinnersInput.value, 10);
  if (Number.isFinite(n)) fullHouseWinnersHint.textContent = n === 1 ? 'winner' : 'winners';
});
fullHouseWinnersInput.addEventListener('change', clampFullHouseWinners);
fullHouseWinnersInput.addEventListener('blur', clampFullHouseWinners);
fullHouseCheck.addEventListener('change', syncFullHouseWinnersState);
syncFullHouseWinnersState();

document.getElementById('hostBtn').addEventListener('click', async () => {
  const ident = getIdentityInputs();
  if (!ident) return;
  const title = document.getElementById('titleInput').value.trim() || 'Housiy Night';
  const maxPlayers = parseInt(document.getElementById('maxPlayersInput').value, 10) || 100;
  const prizes = Array.from(document.querySelectorAll('.prize-check:checked')).map(c => c.value);
  if (prizes.length === 0) { showToast('Select at least one prize', 'danger'); return; }
  const fullHouseWinners = prizes.includes('FULL_HOUSE') ? clampFullHouseWinners() : 1;
  const autoCallEnabled = document.getElementById('autoCallToggle').checked;
  let autoCallIntervalSeconds = parseInt(document.getElementById('autoCallIntervalInput').value, 10) || 5;
  autoCallIntervalSeconds = Math.min(60, Math.max(3, autoCallIntervalSeconds));
  const btn = document.getElementById('hostBtn');
  btn.disabled = true; btn.textContent = 'Creating...';
  const res = await apiPost('room_create.php', {
    name: ident.name, email: ident.email, title, max_players: maxPlayers, prizes, full_house_winners: fullHouseWinners,
    auto_call_enabled: autoCallEnabled, auto_call_interval_seconds: autoCallIntervalSeconds,
  });
  btn.disabled = false; btn.textContent = 'Create Room';
  if (!res.success) { showToast(res.error || 'Failed to create room', 'danger'); return; }
  setStoredIdentity(ident.name, ident.email);
  // room_create.php has established the authenticated server session.
  try { localStorage.setItem('housiy_authenticated', '1'); } catch (_) {}
  window.location.href = `host.html?room=${res.room.room_code}`;
});

document.querySelectorAll('[data-htab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-htab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('hostedList').classList.toggle('d-none', btn.dataset.htab !== 'hosted');
    document.getElementById('joinedList').classList.toggle('d-none', btn.dataset.htab !== 'joined');
  });
});

// History is displayed automatically only after a successful room join/create
// established the server-side authenticated session. A first-time visitor (or
// someone with only a cached name/email) makes no history API request.
async function loadHistory() {
  if (historyLoaded) return { success: true };
  if (historyLoadPromise) return historyLoadPromise;
  historyLoadPromise = (async () => {
    const res = await apiGet('history.php');
    if (!res || !res.success) {
      const error = String(res?.error || 'History request failed');
      if (/authenticat|session|log.?in|unauthori[sz]ed/i.test(error)) {
        try { localStorage.removeItem('housiy_authenticated'); } catch (_) {}
      }
      return res || { success: false, error };
    }
  historyLoaded = true;
  document.getElementById('historyCard').classList.remove('d-none');
  const hostedList = document.getElementById('hostedList');
  const joinedList = document.getElementById('joinedList');
  hostedList.innerHTML = res.hosted_games.length ? res.hosted_games.map(g => `
    <a href="host.html?room=${encodeURIComponent(g.room_code)}" class="d-flex justify-content-between align-items-center py-2 border-bottom border-secondary text-decoration-none text-reset">
      <span>${escapeHtml(g.title)} <span class="text-dim">(${escapeHtml(g.room_code)})</span>
        <span class="d-block text-dim small">${historyTimingLine(g)}</span>
      </span>
      ${statusPill(g.status)}
    </a>`).join('') : '<p class="text-dim">No hosted games yet.</p>';
  joinedList.innerHTML = res.joined_games.length ? res.joined_games.map(g => `
    <a href="player.html?room=${encodeURIComponent(g.room_code)}" class="d-flex justify-content-between align-items-center py-2 border-bottom border-secondary text-decoration-none text-reset">
      <span>${escapeHtml(g.title)} <span class="text-dim">(${escapeHtml(g.room_code)})</span>
        <span class="d-block text-dim small">${historyTimingLine(g)}</span>
      </span>
      ${statusPill(g.status)}
    </a>`).join('') : '<p class="text-dim">No joined games yet.</p>';
    return { success: true };
  })();
  try { return await historyLoadPromise; }
  finally { historyLoadPromise = null; }
}

/** One-line "Started ... · Xm Ys" (or "Not started yet") summary for a
 *  history row, all converted to the viewer's own local time zone. Open
 *  the room itself (host.html/player.html) for the full start/completed/
 *  duration + winners breakdown. */
function historyTimingLine(g) {
  if (!g.started_at) return 'Not started yet';
  const started = `Started ${formatLocalDateTime(g.started_at)}`;
  if (!g.ended_at) return started;
  return `${started} · took ${formatDuration(g.started_at, g.ended_at)}`;
}

// Only an explicit authenticated-session marker permits the history request.
// Do not infer authentication from localStorage identity fields.
