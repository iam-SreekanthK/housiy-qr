initSoundToggle();

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('room') || '').toUpperCase();
if (!roomCode) window.location.href = 'index.html';

document.getElementById('roomCodeText').textContent = roomCode;
document.getElementById('mobileRoomCodeText').textContent = roomCode;

const PRIZE_LABELS = {
  FIRST_FIVE: 'First Five', TOP_ROW: 'Top Row', MIDDLE_ROW: 'Middle Row',
  BOTTOM_ROW: 'Bottom Row', FULL_HOUSE: 'Full House',
};

let previousCalledCount = 0;
let previousCurrentNumber = null;
let previousWinnerKeys = new Set();
let pollTimer = null;
let hostHasTicket = false;
let hostTicketGrid = null;
let hostTicketId = null;
let hostMarkedSet = new Set();
let hostCalledSet = new Set();
let hostMarkInFlight = new Set();
let hostPendingMarks = new Set();
let finalWinnersShown = false; let gameCompleted = false;
let baselineCaptured = false;
let startCountdownTriggered = false;
let startCountdownActive = false;
let gameTimerInterval = null;
let gameTimerSeconds = 0;

function formatGameTimer(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let autoCallUiTimer = null;
let autoCallUiRemaining = null;
let autoCallUiLastTick = Date.now();
let autoCallUiPaused = false;
let autoCallUiRunning = false;
function syncAutoCallUi(room, forceReset = false) {
  const badge = document.getElementById('autoCallBadge');
  const secondsEl = document.getElementById('autoCallSeconds');
  if (!badge || !secondsEl || !room) return;
  const status = String(room.status || '').toUpperCase();
  const enabled = !!room.auto_call_enabled && ['LOBBY','LIVE','PAUSED'].includes(status);
  badge.classList.toggle('d-none', !enabled);
  badge.classList.toggle('pill-plain', enabled && status !== 'PAUSED');
  if (!enabled) {
    if (autoCallUiTimer) clearInterval(autoCallUiTimer);
    autoCallUiTimer = null;
    autoCallUiRemaining = null;
    autoCallUiPaused = false;
    autoCallUiRunning = false;
    secondsEl.textContent = '';
    return;
  }

  const interval = Math.max(3, Number(room.auto_call_interval_seconds || 5));
  // In the lobby this is a setting, not a running countdown. Never display
  // 0s or tick down before the host starts the game.
  if (status === 'LOBBY') {
    if (autoCallUiTimer) clearInterval(autoCallUiTimer);
    autoCallUiTimer = null;
    autoCallUiRemaining = interval;
    autoCallUiPaused = false;
    autoCallUiRunning = false;
    secondsEl.textContent = `(${interval}s)`;
    return;
  }

  autoCallUiPaused = status === 'PAUSED';
  autoCallUiRunning = status === 'LIVE';
  const serverRemaining = room.auto_call_seconds_remaining;
  if (forceReset || autoCallUiRemaining === null || (serverRemaining !== null && serverRemaining !== undefined)) {
    autoCallUiRemaining = serverRemaining !== null && serverRemaining !== undefined
      ? Math.max(0, Number(serverRemaining)) : interval;
    autoCallUiLastTick = Date.now();
  }
  const paint = () => {
    // While paused, retain the server's remaining value; while live, show a
    // locally ticking estimate between authoritative server events.
    secondsEl.textContent = `(${Math.max(0, Math.ceil(autoCallUiRemaining || 0))}s)`;
  };
  paint();
  if (!autoCallUiTimer) {
    autoCallUiTimer = setInterval(() => {
      if (document.hidden || autoCallUiPaused || !autoCallUiRunning || autoCallUiRemaining === null) {
        autoCallUiLastTick = Date.now();
        return;
      }
      const now = Date.now();
      const elapsed = (now - autoCallUiLastTick) / 1000;
      if (elapsed >= 1) {
        autoCallUiRemaining = Math.max(0, autoCallUiRemaining - elapsed);
        autoCallUiLastTick = now;
        paint();
      }
    }, 250);
  }
}

// Matches GameEngine::START_COUNTDOWN_SECONDS (server holds the first
// number call back for this long) and the "5,4,3,2,1 GO!" overlay's own
// duration (see showStartCountdown in common.js) — used below to keep the
// nav-bar timer frozen for the same window, so it starts from "GO!"
// rather than from the moment Start Game was clicked.
const START_COUNTDOWN_MS = 0;

// Nav-bar mm:ss timer. Hidden until the game actually starts, then ticks
// locally once a second while RUNNING and freezes on PAUSED/ENDED. Stays
// frozen at 00:00 through the "5,4,3,2,1 GO!" countdown itself (computed
// straight from res.game.started_at/server_now, not from the
// startCountdownActive flag, so this is correct even on a page load that
// lands mid-countdown) so elapsed time is measured from actual gameplay,
// not from when Start Game was clicked. Synced against the server's own
// started_at/server_now once, on the first poll of this session
// (isFirstLook), the same way the start countdown is — this makes a page
// refresh mid-game land on the right elapsed time without re-syncing every
// poll, which would otherwise inflate the count by however long the game
// happened to sit paused (the server doesn't track paused duration
// separately). It's also stopped the instant the game ends (gameStatus
// !== 'RUNNING'), which happens well before the final-winners card pops up
// (see scheduleFinalWinnersBanner's delay), so the timer never keeps
// ticking behind that popup.
function updateGameTimer(res, isFirstLook) {
  const el = document.getElementById('gameTimer');
  if (!el || !res || !res.game) return;
  const gameStatus = String(res.game.status || '').toUpperCase();
  gameCompleted = (gameStatus === 'ENDED' || gameStatus === 'COMPLETED');
  const parseUtc = (value) => {
    if (!value) return NaN;
    const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
    return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : normalized + 'Z');
  };
  const startedAtMs = parseUtc(res.game.started_at);
  const serverNowMs = parseUtc(res.game.server_now);
  const endedAtMs = parseUtc(res.game.ended_at);
  const serverDelta = Number.isFinite(serverNowMs) ? Date.now() - serverNowMs : 0;
  const nowOnServerClock = Date.now() - serverDelta;

  if (gameStatus === 'NOT_STARTED' || !Number.isFinite(startedAtMs)) {
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    gameTimerInterval = null; gameTimerSeconds = 0;
    el.classList.add('d-none'); el.textContent = '00:00';
    if (typeof syncGameDetailsDuration === 'function') syncGameDetailsDuration(0);
    return;
  }

  const elapsedFromStart = Math.max(0, Math.floor((nowOnServerClock - startedAtMs) / 1000));
  const inCountdown = gameStatus === 'RUNNING' && Number(res.game.numbers_called_count || 0) === 0 &&
    Number.isFinite(serverNowMs) && serverNowMs < startedAtMs;
  if (inCountdown) {
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    gameTimerInterval = null; gameTimerSeconds = 0;
    el.classList.add('d-none'); el.textContent = '00:00';
    return;
  }

  el.classList.remove('d-none');
  // Re-anchor on first snapshot and every transition into RUNNING. A
  // lifecycle event can arrive after the page's initial lobby snapshot;
  // this avoids depending on a page refresh to initialise the clock.
  if (isFirstLook || !Number.isFinite(gameTimerSeconds) || gameTimerSeconds < 0 ||
      (gameStatus === 'RUNNING' && !gameTimerInterval && gameTimerSeconds === 0)) {
    if (gameStatus === 'RUNNING' || gameStatus === 'PAUSED') gameTimerSeconds = elapsedFromStart;
    else if (gameStatus === 'ENDED' || gameStatus === 'COMPLETED') {
      const finish = Number.isFinite(endedAtMs) ? endedAtMs : (Number.isFinite(serverNowMs) ? serverNowMs : Date.now());
      gameTimerSeconds = Math.max(0, Math.floor((finish - startedAtMs) / 1000));
    }
  }
  if (gameStatus === 'RUNNING') {
    if (!gameTimerInterval) {
      let lastTick = Date.now();
      gameTimerInterval = setInterval(() => {
        const now = Date.now();
        const delta = Math.max(0, Math.floor((now - lastTick) / 1000));
        if (!delta) return;
        lastTick += delta * 1000;
        gameTimerSeconds += delta;
        el.textContent = formatGameTimer(gameTimerSeconds);
        if (typeof syncGameDetailsDuration === 'function') syncGameDetailsDuration(gameTimerSeconds);
      }, 250);
    }
  } else if (gameTimerInterval) {
    clearInterval(gameTimerInterval); gameTimerInterval = null;
  }
  el.textContent = formatGameTimer(gameTimerSeconds);
  if (typeof syncGameDetailsDuration === 'function') syncGameDetailsDuration(gameTimerSeconds);
}

// --- Auto-call: host optionally set this up at room creation. The actual
// calling is driven server-side (GameEngine::autoCallIfDue) so it isn't
// dependent on this tab staying active; these vars just track state for
// the status badge. ---
let autoCallEnabled = false;
let autoCallIntervalSeconds = 5;

// --- Hamburger menu (mobile) ---
const hamburgerBtn = document.getElementById('hamburgerBtn');
const mobileMenu = document.getElementById('mobileMenu');
hamburgerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  mobileMenu.classList.toggle('show');
});
document.addEventListener('click', (e) => {
  if (mobileMenu.classList.contains('show') && !mobileMenu.contains(e.target) && e.target !== hamburgerBtn) {
    mobileMenu.classList.remove('show');
  }
});
document.getElementById('mobileCopyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode);
  showToast('Room ID copied to clipboard', 'success');
  mobileMenu.classList.remove('show');
});

async function poll() {
  const res = await apiGet('results.php', { room_code: roomCode });
  if (!res.success) {
    if (res.error && (/authenticat/i.test(res.error) || /room not found|does not exist|unknown room|deleted|invalid room/i.test(res.error))) {
      window.location.replace('index.html');
    }
    return;
  }
  rtAfterResponse(res);
  renderState(res);
  // During WebSocket outages, keep the host's own ticket usable as well.
  if (!rtConnected && hostHasTicket) await pollHostTicket();
  return res;
}

// --- Play Along: the host is auto-enrolled as a player with their own
// ticket at room_create.php time, so this just loads it - no manual
// "join my own room" step needed. The self-heal join below only exists
// for rooms created before this behavior existed / any other edge case
// where the ticket wasn't created up front. ---
async function tryLoadHostTicket(alreadyRetried = false) {
  const res = await apiGet('ticket.php', { room_code: roomCode });
  if (res.success) {
    hostHasTicket = true;
    hostTicketGrid = res.ticket.grid;
    hostTicketId = res.ticket.id;
    hostMarkedSet = new Set(res.marked_numbers || []);
    document.getElementById('playAlongPrompt').classList.add('d-none');
    document.getElementById('hostTicketPanel').classList.remove('d-none');
    syncHostClaimStateFrom(res);
    buildHostClaimButtons(res.room.prizes_enabled);
    renderHostTicket(res);
    return;
  }

  const statusEl = document.getElementById('playAlongStatus');
  const retryBtn = document.getElementById('playAlongBtn');

  if (!alreadyRetried) {
    // Self-heal: try joining as a player once, then re-fetch the ticket.
    const identity = getStoredIdentity();
    if (identity) {
      const joinRes = await apiPost('room_join.php', { name: identity.name, email: identity.email, room_code: roomCode });
      if (joinRes.success) {
        await tryLoadHostTicket(true);
        return;
      }
    }
  }

  statusEl.textContent = 'Could not load your ticket automatically.';
  retryBtn.classList.remove('d-none');
}

document.getElementById('playAlongBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('playAlongBtn');
  const statusEl = document.getElementById('playAlongStatus');
  btn.disabled = true;
  btn.classList.add('d-none');
  statusEl.textContent = 'Loading your ticket...';
  await tryLoadHostTicket();
  btn.disabled = false;
});

async function pollHostTicket() {
  const res = await apiGet('ticket.php', { room_code: roomCode });
  if (res.success) { renderHostTicket(res); return; }
  if (res.error && /room not found|does not exist|unknown room|deleted|invalid room/i.test(res.error)) {
    window.location.replace('index.html');
  }
}

function renderHostTicket(res) {
  hostCalledSet = new Set(res.called_numbers);
  // Merge the server snapshot; never let an older poll erase a local
  // optimistic mark. Server-confirmed values clear their pending marker.
  (res.marked_numbers || []).forEach(n => {
    n = Number(n);
    hostMarkedSet.add(n);
    hostPendingMarks.delete(n);
  });
  renderTicket(document.getElementById('hostTicketContainer'), hostTicketGrid, hostCalledSet, hostMarkedSet, markHostCell, hostTicketId);

  syncHostClaimStateFrom(res);
  refreshHostClaimButtons();
}

/** Host self-marks a called number on their own "play along" ticket. */
async function markHostCell(number) {
  number = Number(number);
  if (!Number.isInteger(number) || number < 1 || number > 90) return;
  if (gameCompleted) return;
  if (hostMarkedSet.has(number) && !hostPendingMarks.has(number)) return;
  if (hostMarkInFlight.has(number)) return;

  hostMarkInFlight.add(number);
  hostPendingMarks.add(number);
  hostMarkedSet.add(number);
  renderTicket(document.getElementById('hostTicketContainer'), hostTicketGrid, hostCalledSet, hostMarkedSet, markHostCell, hostTicketId);

  let lastError = null;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = (typeof window.housiyRealtimeSend === 'function' && rtConnected)
          ? await window.housiyRealtimeSend('MARK_NUMBER', { number }).then(x => x.response || x).catch(err => { if (!rtConnected) return apiPost('mark.php', { room_code: roomCode, number }); throw err; })
          : await apiPost('mark.php', { room_code: roomCode, number });
        if (res && res.success) {
          hostMarkedSet.add(number);
          hostPendingMarks.delete(number);
          lastError = null;
          break;
        }
        // A definitive validation rejection only rolls back this number.
        hostPendingMarks.delete(number);
        hostMarkedSet.delete(number);
        showToast((res && res.error) || 'Could not mark that number', 'danger');
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 4) {
          await new Promise(resolve => setTimeout(resolve, Math.min(2000, 200 * (2 ** attempt))));
        }
      }
    }
    if (lastError) {
      // Keep the optimistic mark visible and retryable after transient network
      // failures; tapping it again retries the idempotent server operation.
      showToast('Mark is visible but not yet confirmed. Check your connection and tap again to retry.', 'warning');
    }
  } finally {
    hostMarkInFlight.delete(number);
    renderTicket(document.getElementById('hostTicketContainer'), hostTicketGrid, hostCalledSet, hostMarkedSet, markHostCell, hostTicketId);
  }
}

// Shared claim state for the host's own ticket. Full House can have several
// winners: total = slots in the room, remaining = still open ("Full House (2)").
let hostClaimState = { prizesWon: [], prizesWonByMe: [], full_house_total: 1, full_house_remaining: 1 };
let hostMultiFullHouse = false;

function syncHostClaimStateFrom(res) {
  hostClaimState = {
    prizesWon: Array.isArray(res.prizes_won) ? res.prizes_won.slice() : hostClaimState.prizesWon,
    prizesWonByMe: Array.isArray(res.prizes_won_by_me) ? res.prizes_won_by_me.slice() : hostClaimState.prizesWonByMe,
    full_house_total: Number(res.room?.full_house_total ?? hostClaimState.full_house_total) || 1,
    full_house_remaining: Number(res.room?.full_house_remaining ?? hostClaimState.full_house_remaining),
  };
  hostMultiFullHouse = hostClaimState.full_house_total > 1;
}

function refreshHostClaimButtons() {
  document.querySelectorAll('#hostClaimButtons .claim-btn').forEach(btn => {
    applyClaimButtonState(btn, btn.dataset.prize, hostClaimState, PRIZE_LABELS[btn.dataset.prize] || btn.dataset.prize);
  });
}

function buildHostClaimButtons(prizesEnabled) {
  const container = document.getElementById('hostClaimButtons');
  container.innerHTML = prizesEnabled.map(p => `
    <button class="btn btn-sm btn-outline-glass claim-btn" data-prize="${p}">
      ${PRIZE_LABELS[p] || p}
    </button>`).join('');
  container.querySelectorAll('.claim-btn').forEach(btn => {
    btn.addEventListener('click', () => submitHostClaim(btn.dataset.prize, btn));
  });
  refreshHostClaimButtons();
}

async function submitHostClaim(prizeType, btn) {
  const pre = precheckClaim(prizeType, hostTicketGrid, hostCalledSet, hostMarkedSet);
  if (!pre.ok && !pre.calledShort) {
    const n = pre.pendingCount;
    showToast(`Still ${n} number${n === 1 ? '' : 's'} pending — mark ${n === 1 ? 'it' : 'them'} on your ticket, then claim again.`, 'warning');
    return;
  }

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Checking...';
  const res = (typeof window.housiyRealtimeSend === 'function' && rtConnected)
    ? await window.housiyRealtimeSend('CLAIM_PRIZE', { prize_type: prizeType }).then(x => x.response || x).catch(err => { if (!rtConnected) return apiPost('claim.php', { room_code: roomCode, prize_type: prizeType }); throw err; })
    : await apiPost('claim.php', { room_code: roomCode, prize_type: prizeType });
  if (res.success && res.valid) {
    showToast(`🎉 Valid claim! You won ${PRIZE_LABELS[prizeType]}`, 'success');
    if (!hostClaimState.prizesWonByMe.includes(prizeType)) hostClaimState.prizesWonByMe.push(prizeType);
    if (prizeType === 'FULL_HOUSE' && res.full_house_remaining != null) {
      hostClaimState.full_house_remaining = Number(res.full_house_remaining);
      if (hostClaimState.full_house_remaining <= 0 && !hostClaimState.prizesWon.includes(prizeType)) hostClaimState.prizesWon.push(prizeType);
    } else if (!hostClaimState.prizesWon.includes(prizeType)) {
      hostClaimState.prizesWon.push(prizeType);
    }
    refreshHostClaimButtons(); // own button turns green; bracket count updates
  } else {
    showToast(res.reason || res.error || 'Claim not valid yet', 'warning');
    btn.textContent = original;
    btn.disabled = false;
  }
}

tryLoadHostTicket();

function renderState(res) {
  const isFirstLook = !baselineCaptured;
  baselineCaptured = true;

  autoCallEnabled = !!res.room.auto_call_enabled;
  autoCallIntervalSeconds = res.room.auto_call_interval_seconds || 5;
  setCallPace(autoCallIntervalSeconds);
  syncAutoCallUi(res.room);

  // Keep the Full House counter in step with the canonical room snapshot.
  if (res.room.full_house_total != null) {
    hostClaimState.full_house_total = Number(res.room.full_house_total) || 1;
    hostClaimState.full_house_remaining = Number(res.room.full_house_remaining) || 0;
    hostMultiFullHouse = hostClaimState.full_house_total > 1;
    if (hostClaimState.full_house_remaining <= 0 && (res.winners || []).some(w => w.prize_type === 'FULL_HOUSE') && !hostClaimState.prizesWon.includes('FULL_HOUSE')) {
      hostClaimState.prizesWon.push('FULL_HOUSE');
    }
    refreshHostClaimButtons();
  }

  document.getElementById('roomStatusPill').innerHTML = statusPill(res.room.status);
  document.getElementById('playerCount').textContent = res.room.player_count;
  document.getElementById('maxPlayers').textContent = res.room.max_players;
  document.getElementById('calledCount').textContent = res.game.numbers_called_count;
  document.getElementById('currentNumberDisplay').textContent = res.game.current_number ?? '–';
  document.getElementById('participantsCount').textContent = res.players.length;

  // Pass the same locally-ticking counter that drives the nav-bar timer
  // (rather than letting renderGameDetails recompute independently from
  // Date.now()) so the two never show a different "in progress" duration.
  // updateGameTimer() right after this will overwrite gameTimerSeconds if
  // this is the first poll of the session, then keep both in lockstep on
  // every subsequent tick via syncGameDetailsDuration().
  renderGameDetails(res.room, res.room && !res.room.ended_at ? gameTimerSeconds : undefined);

  updateGameTimer(res, isFirstLook);

  renderPlayersList(document.getElementById('playersList'), res.players);

  const calledSet = new Set(res.called_numbers);
  renderBoard(document.getElementById('numberBoard'), calledSet, res.game.current_number);

  // animate + speak when a new number just landed — but never on the very
  // first poll of a session (isFirstLook): that's just the dashboard
  // loading whatever the room's current state already is (including a
  // completed match's last-called number), not a fresh call to read out.
  if (res.game.numbers_called_count > previousCalledCount) {
    const disp = document.getElementById('currentNumberDisplay');
    disp.style.animation = 'none';
    void disp.offsetWidth;
    disp.style.animation = '';
  }
  if (!isFirstLook && res.game.current_number != null && res.game.current_number !== previousCurrentNumber) {
    // Announce every number that landed since the last snapshot, in call order.
    const newlyCalled = (res.called_numbers || []).slice(previousCalledCount);
    if (newlyCalled.length > 1) speakMissedNumbers(newlyCalled);
    else speakNumber(res.game.current_number);
  }
  previousCurrentNumber = res.game.current_number;
  previousCalledCount = res.game.numbers_called_count;

  // Start countdown: the instant the game flips to RUNNING with nothing
  // called yet, show the shared "5,4,3,2,1" overlay — computed against
  // the server's own started_at/server_now so it lands on the correct
  // number even if this poll came in a little late. The server itself
  // holds the first call back for the same duration (see
  // GameEngine::START_COUNTDOWN_SECONDS), so this can never show a stale
  // countdown for a number that's already been called.
  if (!startCountdownTriggered && res.game.status === 'RUNNING' && res.game.numbers_called_count === 0 && res.game.started_at) {
    startCountdownTriggered = true;
    const startedAtMs = Date.parse(res.game.started_at.replace(' ', 'T') + 'Z');
    const serverNowMs = res.game.server_now ? Date.parse(res.game.server_now.replace(' ', 'T') + 'Z') : Date.now();
    const remaining = Math.max(0, startedAtMs - serverNowMs - 1000);
    if (remaining > 200) {
      startCountdownActive = true;
      showStartCountdown(remaining, () => {
        startCountdownActive = false;
        // The countdown completion is a local UI transition. With a healthy
        // WebSocket there may be no further snapshot event, leaving Next
        // disabled until the host pauses/resumes or refreshes. Reconcile once
        // when the countdown ends so mobile and desktop controls unlock alike.
        poll().catch(error => console.warn('[Housiy host] post-countdown refresh failed:', error));
      });
    }
  }

  // winners
  const winnersList = document.getElementById('winnersList');
  if (res.winners.length === 0) {
    winnersList.innerHTML = '<p class="text-dim small mb-0">No winners yet.</p>';
  } else {
    winnersList.innerHTML = res.winners.map(w => `
      <div class="winner-item">
        <span class="winner-item-prizecol">
          <span class="winner-item-prize">${escapeHtml(winnerListPrizeLabel(w, w.prize_type.replace('_',' '), hostMultiFullHouse || res.winners.filter(x => x.prize_type === 'FULL_HOUSE').length > 1))}</span>
          ${w.claimed_at ? `<span class="winner-item-time">${escapeHtml(formatLocalTimeSeconds(w.claimed_at))}</span>` : ''}
        </span>
        <span class="winner-item-info">
          <span class="winner-item-name">${escapeHtml(w.winner_name)}</span>
          ${w.winner_email ? `<span class="winner-item-email">${escapeHtml(w.winner_email)}</span>` : ''}
        </span>
      </div>`).join('');
  }

  if (isFirstLook) {
    // First poll of this room this session. If it's already finished
    // (host reopens/refreshes a completed dashboard), just record what's
    // already there — show the winners list as plain info, no replayed
    // banners/confetti/winner card.
    previousWinnerKeys = new Set(res.winners.map(w => winnerKey(w.prize_type, w.winner_position)));
    if (res.game.status === 'ENDED' || res.room.status === 'COMPLETED') {
      finalWinnersShown = true;
    }
  } else {
    res.winners.forEach(w => {
      const key = winnerKey(w.prize_type, w.winner_position);
      if (!previousWinnerKeys.has(key)) {
        announceRoomWinnerOnce(w.winner_name, w.prize_type, w.winner_email, w.winner_position || 1, hostClaimState.full_house_total || 1);
      }
    });
    previousWinnerKeys = new Set(res.winners.map(w => winnerKey(w.prize_type, w.winner_position)));

    // Once the game is over — every enabled prize actually claimed
    // (GameEngine::checkAndAutoEnd), or the host manually clicked "End
    // Game" — show one summary banner listing every prize winner instead
    // of relying on the one-at-a-time popups alone. Running out of numbers
    // to call is *not* by itself enough to trigger this — see
    // checkAndAutoEnd()'s docblock. If nobody won any prize at all,
    // there's nothing to show or celebrate — end quietly and head straight
    // back to the home screen. If at least one prize was won, show the
    // winner card and stay on the dashboard (no auto-redirect) so the host
    // can use the Rematch button once they're ready.
    if ((res.game.status === 'ENDED' || res.room.status === 'COMPLETED') && !finalWinnersShown) {
      finalWinnersShown = true;
      if (res.winners.length > 0) {
        scheduleFinalWinnersBanner(res.winners);
      } else {
        window.location.href = 'index.html';
      }
    }
  }

  // button states
  const status = res.room.status;
  const gameStatus = res.game.status;
  document.getElementById('startBtn').disabled = status !== 'LOBBY';
  const pauseResumeBtn = document.getElementById('pauseResumeBtn');
  if (pauseResumeBtn) {
    const paused = gameStatus === 'PAUSED';
    pauseResumeBtn.disabled = !['RUNNING','PAUSED'].includes(gameStatus);
    pauseResumeBtn.title = paused ? 'Resume' : 'Pause';
    pauseResumeBtn.querySelector('.ic').textContent = paused ? '▶' : '⏸';
    pauseResumeBtn.querySelector('.btn-label').textContent = paused ? 'Resume' : 'Pause';
    pauseResumeBtn.querySelector('.btn-label-short').textContent = paused ? 'Resume' : 'Pause';
  }
  document.getElementById('nextBtn').disabled = gameStatus !== 'RUNNING' || res.game.numbers_called_count >= 90 || startCountdownActive;
  document.getElementById('endBtn').disabled = ['COMPLETED','NOT_STARTED'].includes(status) || gameStatus === 'ENDED';

  if (gameStatus === 'ENDED' || status === 'COMPLETED') {
    document.getElementById('nextBtn').disabled = true;
  }

  // Auto-call: the actual calling now happens server-side (see
  // GameEngine::autoCallIfDue), triggered by anyone's poll — host or
  // player — so it keeps going even if this host tab goes idle/backgrounded
  // and its own timers get throttled. This badge is just a status
  // indicator now; it doesn't fire calls itself, which also avoids racing
  // the server's own timing and double-calling numbers.
  //
  // Visible for Lobby/Live/Paused whenever auto-call is on (not just
  // while numbers are actively being called), styled as a full badge
  // only while Paused — Lobby and Live show it as plain text so it
  // doesn't compete for space with the game controls.
  syncAutoCallUi(res.room);

  // Rematch: only offered once the game has actually ended.
  const rematchBtn = document.getElementById('rematchBtn');
  const controlsGrid = document.querySelector('.host-shell .controls-grid');
  if (status === 'COMPLETED') {
    const winnersOverlayOpen = !!document.getElementById('finalWinnersOverlay');
    rematchBtn.classList.toggle('d-none', winnersOverlayOpen);
    if (controlsGrid) controlsGrid.classList.toggle('has-rematch', !winnersOverlayOpen);

    if (res.room.rematch_room_code) {
      rematchBtn.querySelector('.btn-label').textContent = `Go to New Game (${res.room.rematch_room_code})`;
      rematchBtn.querySelector('.ic').textContent = '➡';
      rematchBtn.dataset.existing = res.room.rematch_room_code;
    } else {
      rematchBtn.querySelector('.btn-label').textContent = 'Start Rematch';
      rematchBtn.querySelector('.ic').textContent = '🔁';
      delete rematchBtn.dataset.existing;
    }
  } else {
    rematchBtn.classList.add('d-none');
    if (controlsGrid) controlsGrid.classList.remove('has-rematch');
  }

  if (!hostHasTicket) {
    const statusEl = document.getElementById('playAlongStatus');
    if (status !== 'LOBBY') {
      statusEl.textContent = 'Ticket unavailable - the game already started.';
      document.getElementById('playAlongBtn').classList.add('d-none');
    }
  }
}

document.getElementById('copyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode);
  showToast('Room ID copied to clipboard', 'success');
});

async function callAction(path, btn, label) {
  if (btn.dataset.actionPending === '1') return;
  btn.dataset.actionPending = '1';
  btn.disabled = true;
  const labelEl = btn.querySelector('.btn-label');
  const shortLabelEl = btn.querySelector('.btn-label-short');
  const original = labelEl ? labelEl.textContent : btn.textContent;
  const originalShort = shortLabelEl ? shortLabelEl.textContent : null;
  if (labelEl) labelEl.textContent = label; else btn.textContent = label;
  if (shortLabelEl) shortLabelEl.textContent = label;
  let succeeded = false;
  try {
    const res = await apiPost(path, { room_code: roomCode });
    succeeded = !!res.success;
    if (!res.success) showToast(res.error || 'Action failed', 'danger');
    return res;
  } catch (error) {
    showToast(error?.message || 'Action failed. Please try again.', 'danger');
    return { success: false, error: error?.message || 'Network error' };
  } finally {
    if (labelEl) labelEl.textContent = original; else btn.textContent = original;
    if (shortLabelEl) shortLabelEl.textContent = originalShort;
    btn.dataset.actionPending = '0';
    // Never leave a control disabled because a request or socket event was missed.
    btn.disabled = false;
    // Reconcile the authoritative state after the action; renderState will
    // re-disable controls only when the game state genuinely requires it.
    if (succeeded) await poll();
  }
}

document.getElementById('startBtn').addEventListener('click', async (e) => { await callAction('game_start.php', e.currentTarget, 'Starting...'); await poll(); });
document.getElementById('pauseResumeBtn').addEventListener('click', async (e) => {
  const paused = e.currentTarget.querySelector('.btn-label').textContent === 'Resume';
  await callAction(paused ? 'game_resume.php' : 'game_pause.php', e.currentTarget, paused ? 'Resuming...' : 'Pausing...');
  await poll();
});
document.getElementById('nextBtn').addEventListener('click', async (e) => {
  await callAction('game_next.php', e.currentTarget, 'Calling...');
});
document.getElementById('endBtn').addEventListener('click', (e) => {
  if (!confirm('End this game for all players? This cannot be undone.')) return;
  callAction('game_end.php', e.currentTarget, 'Ending...');
});
document.getElementById('rematchBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.dataset.existing) {
    window.location.href = `host.html?room=${btn.dataset.existing}`;
    return;
  }
  openRematchModal();
});

/** Prompts the host for the rematch's auto-call setting before creating
 *  the new room — prefilled from whatever this game was already using,
 *  so confirming as-is just carries the same pace forward, and bumping
 *  the seconds up (or turning auto-call on/off) is a quick edit rather
 *  than a whole new setup flow. */
function openRematchModal() {
  const toggle = document.getElementById('rematchAutoCallToggle');
  const intervalWrap = document.getElementById('rematchIntervalWrap');
  const intervalInput = document.getElementById('rematchIntervalInput');
  const hint = document.getElementById('rematchIntervalHint');

  toggle.checked = autoCallEnabled;
  intervalInput.value = autoCallIntervalSeconds || 5;
  hint.textContent = autoCallEnabled
    ? `Previously set to ${autoCallIntervalSeconds || 5}s — increase it or keep as is.`
    : '';
  intervalWrap.classList.toggle('d-none', !toggle.checked);

  document.getElementById('rematchModalOverlay').classList.remove('d-none');
}

function closeRematchModal() {
  document.getElementById('rematchModalOverlay').classList.add('d-none');
}

document.getElementById('rematchAutoCallToggle').addEventListener('change', (e) => {
  document.getElementById('rematchIntervalWrap').classList.toggle('d-none', !e.target.checked);
});

document.getElementById('rematchModalCancel').addEventListener('click', closeRematchModal);
document.getElementById('rematchModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'rematchModalOverlay') closeRematchModal();
});

document.getElementById('rematchModalConfirm').addEventListener('click', async () => {
  const rematchBtn = document.getElementById('rematchBtn');
  const confirmBtn = document.getElementById('rematchModalConfirm');
  const toggle = document.getElementById('rematchAutoCallToggle');
  const intervalInput = document.getElementById('rematchIntervalInput');

  let interval = parseInt(intervalInput.value, 10);
  if (isNaN(interval)) interval = autoCallIntervalSeconds || 5;
  interval = Math.min(60, Math.max(3, interval));

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Creating...';
  rematchBtn.disabled = true;
  rematchBtn.querySelector('.btn-label').textContent = 'Creating new game...';

  const res = await apiPost('room_rematch.php', {
    room_code: roomCode,
    auto_call_enabled: toggle.checked,
    auto_call_interval_seconds: interval,
  });

  if (!res.success) {
    showToast(res.error || 'Could not start a rematch', 'danger');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Start Rematch';
    rematchBtn.disabled = false;
    rematchBtn.querySelector('.btn-label').textContent = 'Start Rematch';
    return;
  }
  window.location.href = `host.html?room=${res.room_code}`;
});

// Reveal the Rematch control immediately after the host dismisses the final-winners popup.
window.addEventListener('housiy:final-winners-closed', () => {
  if (typeof poll === 'function') poll();
});

poll();
pollTimer = startRealtime(roomCode, poll);
window.addEventListener('housiy:realtime', (event) => {
  const detail = event.detail || {}, type = detail.type;
  // Accept the current `reaction` envelope and equivalent `data`/`payload`
  // envelopes during a rolling frontend/gateway deployment.
  const data = detail.reaction || detail.data || detail.payload || {};
  if (type === 'game_ended') {
    const finalWinners = Array.isArray(data.final_winners) ? data.final_winners : [];
    if (finalWinners.length) {
      finalWinnersShown = true;
      showFinalWinnersOnce(finalWinners, roomCode);
    } else {
      // Older gateways may omit the payload; retrieve the canonical snapshot
      // once, without waiting for another number-call action.
      void poll().catch(error => console.warn('[Housiy host] final winners recovery failed:', error));
    }
  }
  if (type === 'prize_won') {
    const prize = String(data.prize_type || '').toUpperCase();
    const winnerName = String(data.winner_name || data.player_name || '').trim();
    const position = Number(data.winner_position) || 1;
    const eventKey = winnerKey(prize, position);
    if (prize === 'FULL_HOUSE' && data.full_house_total != null) {
      hostClaimState.full_house_total = Number(data.full_house_total) || 1;
      hostClaimState.full_house_remaining = Number(data.full_house_remaining) || 0;
      hostMultiFullHouse = hostClaimState.full_house_total > 1;
      if (hostClaimState.full_house_remaining <= 0 && !hostClaimState.prizesWon.includes(prize)) hostClaimState.prizesWon.push(prize);
    } else if (prize && !hostClaimState.prizesWon.includes(prize)) {
      hostClaimState.prizesWon.push(prize);
    }
    if (prize && winnerName && !previousWinnerKeys.has(eventKey)) {
      previousWinnerKeys.add(eventKey);
      announceRoomWinnerOnce(winnerName, prize, data.winner_email || null, position, data.full_house_total || 1);
    }
    if (prize) refreshHostClaimButtons();
    // Event-triggered canonical refresh updates the winners list immediately
    // and covers gateway payloads that omit winner details. No timer polling.
    void poll().catch(error => console.warn('[Housiy host] prize event reconciliation failed:', error));
  }
  if (type === 'number_called' && Number.isInteger(Number(data.number))) {
    syncAutoCallUi({auto_call_enabled:autoCallEnabled,status:'LIVE',auto_call_interval_seconds:autoCallIntervalSeconds,auto_call_seconds_remaining:autoCallIntervalSeconds}, true);
    const n = Number(data.number);
    // Keep the WebSocket and snapshot paths on the same number baseline.
    // Otherwise the next poll sees this same number as 'new' and speaks it twice.
    const isNewCalledNumber = !hostCalledSet.has(n);
    previousCurrentNumber = n;
    hostCalledSet.add(n);
    previousCalledCount = Math.max(previousCalledCount, hostCalledSet.size);
    const board = document.getElementById('numberBoard');
    if (board) renderBoard(board, hostCalledSet, n);
    const current = document.getElementById('currentNumberDisplay');
    if (current) current.textContent = String(n);
    const count = document.getElementById('calledCount');
    if (count) count.textContent = String(hostCalledSet.size);
    if (isNewCalledNumber) speakNumber(n);
    if (hostHasTicket) renderTicket(document.getElementById('hostTicketContainer'), hostTicketGrid, hostCalledSet, hostMarkedSet, markHostCell, hostTicketId);
  }
  if (type === 'ticket_marked' && hostHasTicket && Number(data.ticket_id) === Number(hostTicketId) && Number.isInteger(Number(data.number))) {
    hostMarkedSet.add(Number(data.number));
    renderTicket(document.getElementById('hostTicketContainer'), hostTicketGrid, hostCalledSet, hostMarkedSet, markHostCell, hostTicketId);
  }
});

window.addEventListener('housiy:final-winners-opened', () => {
  const btn = document.getElementById('rematchBtn');
  if (btn) btn.classList.add('d-none');
});
window.addEventListener('housiy:final-winners-closed', () => {
  const btn = document.getElementById('rematchBtn');
  if (btn && document.getElementById('roomStatusPill')?.textContent.includes('Completed')) btn.classList.remove('d-none');
});
