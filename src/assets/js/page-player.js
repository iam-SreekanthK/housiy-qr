initSoundToggle();

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('room') || '').toUpperCase();
if (!roomCode) window.location.href = 'index.html';

const PRIZE_LABELS = {
  FIRST_FIVE: 'First Five', TOP_ROW: 'Top Row', MIDDLE_ROW: 'Middle Row',
  BOTTOM_ROW: 'Bottom Row', FULL_HOUSE: 'Full House',
};

let ticketGrid = null;
let ticketId = null;
// markedSet only ever grows via the player's own tap (markCell -> mark.php),
// or by hydrating from the server's marked_numbers on load/poll — never
// auto-added just because a number was called.
let markedSet = new Set(); // union of server-confirmed and locally pending marks
let pendingMarks = new Set(); // optimistic marks not yet acknowledged by the server
let previousWinnerKeys = new Set();
// A winner can be observed through the claim response, WebSocket event, and
// canonical snapshot. Announce it once per prize in this page session.
const announcedWinnerKeys = new Set();
let previousCurrentNumber = null;
let calledSetGlobal = new Set();
let markInFlight = new Set();
let finalWinnersShown = false; let gameCompleted = false;
let baselineCaptured = false;
let startCountdownTriggered = false;
let gameTimerInterval = null;
let gameTimerSeconds = 0;
let gameTimerBaselineCaptured = false;
let playerAutoCallIntervalSeconds = 5;
let playerAutoCallEnabled = false;
let playerRoomStatus = 'LOBBY';
// Completed rooms retain their room-scoped WebSocket for rematch lifecycle events.
let roomExtrasInFlight = null;
let roomExtrasLastFetchAt = 0;
let initialRoomExtrasLoaded = false;
const voicedRematchRooms = new Set();

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
// rather than from the moment the host clicked Start Game.
const START_COUNTDOWN_MS = 0;

// Nav-bar mm:ss timer, mirroring the host dashboard's (see page-host.js).
// Hidden until the game starts, then ticks locally once a second while
// RUNNING and freezes on PAUSED/ENDED. Stays frozen at 00:00 through the
// "5,4,3,2,1 GO!" countdown itself (computed straight from
// res.game.started_at/server_now, so this is correct even on a page load
// that lands mid-countdown) so elapsed time is measured from actual
// gameplay, not from when Start Game was clicked. Synced against the
// server's own started_at/server_now once, on the first poll of this
// session, so a page refresh mid-game lands on the right elapsed time.
// It's also stopped the instant the game ends (gameStatus !== 'RUNNING'),
// which happens well before the final-winners card pops up (see
// scheduleFinalWinnersBanner's delay), so the timer never keeps ticking
// behind that popup.
function updateGameTimer(res, isFirstLook) {
  const el = document.getElementById('gameTimer');
  if (!el || !res || !res.game) return;
  const gameStatus = String(res.game.status || '').toUpperCase();
  gameCompleted = (gameStatus === 'ENDED' || gameStatus === 'COMPLETED');
  if (gameCompleted && pendingMarks.size) {
    // Only unacknowledged optimistic marks are rolled back. Server-confirmed
    // marks remain visible in the completed ticket.
    pendingMarks.forEach(number => markedSet.delete(number));
    pendingMarks.clear();
  }
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

async function loadTicket() {
  const res = await apiGet('ticket.php', { room_code: roomCode });
  if (!res.success) {
    if (res.error && /deleted by the administrator/i.test(res.error)) {
      window.location.replace('index.html?notice=admin_room_deleted');
    } else if (res.error && /room not found|does not exist|deleted|invalid room/i.test(res.error)) {
      window.location.replace('index.html?notice=room_deleted');
    } else if (res.error && /joined|authenticat|blocked|access to this room/i.test(res.error)) {
      window.location.replace('index.html?notice=player_blocked&rejoin=' + encodeURIComponent(roomCode));
    }
    return;
  }
  document.getElementById('roomTitleText').textContent = `${res.room.title} (${res.room.room_code})`;
  ticketGrid = res.ticket.grid;
  ticketId = res.ticket.id;
  syncClaimStateFrom(res);
  buildClaimButtons(res.room.prizes_enabled);
  previousCurrentNumber = res.game.current_number;
  renderAll(res);
  void fetchRoomExtras().finally(() => { initialRoomExtrasLoaded = true; });
}

// Shared claim state. Full House can have several winners: total is how many
// slots the room has, remaining how many are still open ("Full House (2)").
let claimState = { prizesWon: [], prizesWonByMe: [], full_house_total: 1, full_house_remaining: 1 };
let roomHasMultiFullHouse = false;

function fullHouseTotalNow() { return claimState.full_house_total || 1; }

function syncClaimStateFrom(res) {
  claimState = {
    prizesWon: Array.isArray(res.prizes_won) ? res.prizes_won.slice() : claimState.prizesWon,
    prizesWonByMe: Array.isArray(res.prizes_won_by_me) ? res.prizes_won_by_me.slice() : claimState.prizesWonByMe,
    full_house_total: Number(res.room?.full_house_total ?? claimState.full_house_total) || 1,
    full_house_remaining: Number(res.room?.full_house_remaining ?? claimState.full_house_remaining),
  };
  roomHasMultiFullHouse = claimState.full_house_total > 1;
}

function refreshClaimButtons() {
  document.querySelectorAll('#claimButtons .claim-btn').forEach(btn => {
    applyClaimButtonState(btn, btn.dataset.prize, claimState, PRIZE_LABELS[btn.dataset.prize] || btn.dataset.prize);
  });
}

function buildClaimButtons(prizesEnabled) {
  const container = document.getElementById('claimButtons');
  container.innerHTML = prizesEnabled.map(p => `
    <button class="btn btn-outline-glass btn-sm claim-btn" data-prize="${p}">
      ${PRIZE_LABELS[p] || p}
    </button>`).join('');
  container.querySelectorAll('.claim-btn').forEach(btn => {
    btn.addEventListener('click', () => submitClaim(btn.dataset.prize, btn));
  });
  refreshClaimButtons();
}

function announceWinnerOnce(winnerName, prizeType, winnerEmail = null, position = 1, total = 1) {
  const prize = String(prizeType || '').toUpperCase();
  const key = winnerKey(prize, position);
  if (!prize || announcedWinnerKeys.has(key)) return false;
  announcedWinnerKeys.add(key);
  previousWinnerKeys.add(key);
  return announceRoomWinnerOnce(winnerName, prize, winnerEmail, position, total);
}

async function submitClaim(prizeType, btn) {
  // Instant client-side nudge if the player hasn't personally marked every
  // number this prize needs yet — even if all of them have already been
  // called. The server re-checks this for real before awarding anything.
  const pre = precheckClaim(prizeType, ticketGrid, calledSetGlobal, markedSet);
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
    if (!claimState.prizesWonByMe.includes(prizeType)) claimState.prizesWonByMe.push(prizeType);
    if (prizeType === 'FULL_HOUSE' && res.full_house_remaining != null) {
      claimState.full_house_remaining = Number(res.full_house_remaining);
      if (claimState.full_house_remaining <= 0 && !claimState.prizesWon.includes(prizeType)) claimState.prizesWon.push(prizeType);
    } else if (!claimState.prizesWon.includes(prizeType)) {
      claimState.prizesWon.push(prizeType);
    }
    refreshClaimButtons(); // winner's own button turns green; bracket count updates
    // Do not announce locally from the HTTP/WS command response. Every player,
    // including the claimant, receives the same room-wide prize_won event and
    // uses the same popup + voice handler. This keeps timing and presentation
    // consistent across all players and avoids the claimant winning the race.
  } else if (res.pending_count > 0) {
    showToast(res.reason || `Still ${res.pending_count} number(s) pending.`, 'warning');
    btn.textContent = original;
    btn.disabled = false;
  } else {
    showToast(res.reason || res.error || 'Claim not valid yet', 'warning');
    btn.textContent = original;
    btn.disabled = false;
  }
  // Claim result is authoritative in this response; the room WebSocket
  // broadcasts winner/lifecycle changes. No follow-up ticket/results fetch.
}

/** Called only when the PLAYER taps a called number on their own ticket.
 *  UI updates synchronously; the server remains authoritative for acceptance
 *  and prize claims. Requests are idempotent, so bounded retries are safe. */
async function markCell(number) {
  number = Number(number);
  if (!Number.isInteger(number) || number < 1 || number > 90) return;
  if (gameCompleted) return;
  if (!ticketGrid || !calledSetGlobal.has(number)) return;
  const onTicket = ticketGrid.some(row => Array.isArray(row) && row.some(value => Number(value) === number));
  if (!onTicket || (markedSet.has(number) && !pendingMarks.has(number)) || markInFlight.has(number)) return;

  // Optimistic update: do not wait for the API before turning the cell green.
  markInFlight.add(number);
  pendingMarks.add(number);
  markedSet.add(number);
  renderTicket(document.getElementById('ticketContainer'), ticketGrid, calledSetGlobal, markedSet, markCell, ticketId);

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (gameCompleted) {
      pendingMarks.delete(number);
      markedSet.delete(number);
      lastError = null;
      break;
    }
    try {
      const res = (typeof window.housiyRealtimeSend === 'function' && rtConnected)
        ? await window.housiyRealtimeSend('MARK_NUMBER', { number }).then(x => x.response || x).catch(err => { if (!rtConnected) return apiPost('mark.php', { room_code: roomCode, number }); throw err; })
        : await apiPost('mark.php', { room_code: roomCode, number });
      if (res && res.success) {
        // Merge, never replace: another mark may have been made while this
        // request was in flight, and an older response may omit that mark.
        (res.marked_numbers || []).forEach(n => markedSet.add(Number(n)));
        markedSet.add(number);
        pendingMarks.delete(number);
        lastError = null;
        break;
      }

      // A server validation rejection is authoritative; undo only this mark,
      // never roll back a snapshot that could contain other concurrent marks.
      pendingMarks.delete(number);
      markedSet.delete(number);
      showToast((res && res.error) || 'The server rejected this mark.', 'danger');
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await new Promise(resolve => setTimeout(resolve, Math.min(2000, 200 * (2 ** attempt))));
      }
    }
  }

  markInFlight.delete(number);
  renderTicket(document.getElementById('ticketContainer'), ticketGrid, calledSetGlobal, markedSet, markCell, ticketId);
  if (lastError) {
    // Keep the optimistic mark visible as pending. Do not silently discard a
    // mark on a transient network error; a later poll can reconcile it.
    showToast('Mark is visible but not yet confirmed. Check your connection and tap the number again shortly.', 'warning');
  }
}

async function poll() {
  const res = await apiGet('ticket.php', { room_code: roomCode });
  if (!res.success) {
    if (res.error && /deleted by the administrator/i.test(res.error)) {
      window.location.replace('index.html?notice=admin_room_deleted');
    } else if (res.error && /room not found|does not exist|deleted|invalid room/i.test(res.error)) {
      window.location.replace('index.html?notice=room_deleted');
    } else if (res.error && /authenticat|blocked|joined|access to this room/i.test(res.error)) {
      window.location.replace('index.html?notice=player_blocked&rejoin=' + encodeURIComponent(roomCode));
    }
    return;
  }
  rtAfterResponse(res);
  renderAll(res);

  // During a WebSocket outage the ticket snapshot alone is not enough to
  // recover prize announcements: ticket.php intentionally omits the public
  // winners list. Read the room extras through the canonical results endpoint
  // while disconnected so every player (including the claimant) discovers a
  // newly committed winner and uses announceWinnerOnce() for the same popup
  // and voice path as the prize_won WebSocket event. The room-extras request
  // is single-flight and its winner-key set prevents replay/duplicates after
  // reconnect. This is outage-only; healthy WebSocket sessions do not poll it.
  if (!rtConnected) {
    await fetchRoomExtras({ fresh: true });
  }
  return res;
}

// Apply high-frequency room events locally. Canonical ticket/results reads are
// reserved for initial load, reconnect, sequence-gap recovery and lifecycle
// changes; a called number or another player's mark must not cause HTTP polling.
window.addEventListener('housiy:realtime', (event) => {
  const detail = event.detail || {}, type = detail.type, data = detail.reaction || {};
  if (type === 'game_started') {
    announcedWinnerKeys.clear();
    previousWinnerKeys.clear();
  }
  if (type === 'game_ended') {
    const finalWinners = Array.isArray(data.final_winners) ? data.final_winners : [];
    if (finalWinners.length) {
      finalWinnersShown = true;
      showFinalWinnersOnce(finalWinners, roomCode);
    } else {
      void fetchRoomExtras({ fresh: true }).catch(error => console.warn('[Housiy player] final winners recovery failed:', error));
    }
  }
  if (type === 'hello' && initialRoomExtrasLoaded) {
    void fetchRoomExtras(); // reconnect: refresh lifecycle/roster snapshot once
  } else if (['room_state_sync','player_joined','player_left','player_removed','game_started','game_paused','game_resumed','game_ended','prize_won'].includes(type)) {
    void fetchRoomExtras({ fresh: type === 'room_state_sync' || type === 'prize_won' || type === 'player_removed' });
  }
  if (type === 'number_called' && Number.isInteger(Number(data.number))) {
    syncAutoCallUi({auto_call_enabled:playerAutoCallEnabled,status:playerRoomStatus,auto_call_interval_seconds:playerAutoCallIntervalSeconds,auto_call_seconds_remaining:playerAutoCallIntervalSeconds}, true);
    const number = Number(data.number);
    if (!calledSetGlobal.has(number)) {
      calledSetGlobal.add(number);
      previousCurrentNumber = number;
      const current = document.getElementById('currentNumberDisplay');
      if (current) current.textContent = String(number);
      const count = document.getElementById('calledCount');
      if (count) count.textContent = String(calledSetGlobal.size);
      renderBoard(document.getElementById('numberBoard'), calledSetGlobal, number);
      renderTicket(document.getElementById('ticketContainer'), ticketGrid, calledSetGlobal, markedSet, markCell, ticketId);
      speakNumber(number);
    }
  } else if (type === 'ticket_marked' && Number(data.ticket_id) === Number(ticketId) && Number.isInteger(Number(data.number))) {
    markedSet.add(Number(data.number));
    pendingMarks.delete(Number(data.number));
    renderTicket(document.getElementById('ticketContainer'), ticketGrid, calledSetGlobal, markedSet, markCell, ticketId);
  } else if (type === 'prize_won') {
    const prize = String(data.prize_type || '').toUpperCase();
    if (prize === 'FULL_HOUSE' && data.full_house_total != null) {
      // Several Full House winners: this event carries the slots left.
      claimState.full_house_total = Number(data.full_house_total) || 1;
      claimState.full_house_remaining = Number(data.full_house_remaining) || 0;
      roomHasMultiFullHouse = claimState.full_house_total > 1;
      if (claimState.full_house_remaining <= 0 && !claimState.prizesWon.includes(prize)) claimState.prizesWon.push(prize);
    } else if (prize && !claimState.prizesWon.includes(prize)) {
      claimState.prizesWon.push(prize);
    }
    refreshClaimButtons();
    if (data.winner_name && prize) announceWinnerOnce(data.winner_name, prize, data.winner_email || null, data.winner_position || 1, data.full_house_total || 1);
  }
});

function renderAll(res) {
  const isFirstTimerLook = !gameTimerBaselineCaptured;
  gameTimerBaselineCaptured = true;
  updateGameTimer(res, isFirstTimerLook);

  playerAutoCallEnabled = !!res.room.auto_call_enabled;
  playerAutoCallIntervalSeconds = Math.max(3, Number(res.room.auto_call_interval_seconds || 5));
  playerRoomStatus = String(res.room.status || 'LOBBY').toUpperCase();

  document.getElementById('roomStatusPill').innerHTML = statusPill(res.room.status);
  document.getElementById('currentNumberDisplay').textContent = res.game.current_number ?? '–';
  document.getElementById('calledCount').textContent = res.game.numbers_called_count;
  document.getElementById('playerCount').textContent = res.room.player_count;
  document.getElementById('maxPlayers').textContent = res.room.max_players;
  const previouslyCalled = calledSetGlobal;
  calledSetGlobal = new Set((res.called_numbers || []).map(Number));
  // Merge server-confirmed marks into local state. Preserve pending optimistic
  // marks so a stale/in-flight ticket poll cannot erase a just-tapped green cell.
  (res.marked_numbers || []).forEach(n => {
    n = Number(n);
    markedSet.add(n);
    pendingMarks.delete(n);
  });
  // Never auto-mark a number just because it was called.

  // Start countdown: mirrors the host dashboard — the instant the game
  // flips to RUNNING with nothing called yet, show the shared
  // "5,4,3,2,1" overlay, computed against the server's own
  // started_at/server_now so every player lands on the correct number
  // even if their poll came in a little late.
  if (!startCountdownTriggered && res.game.status === 'RUNNING' && res.game.numbers_called_count === 0 && res.game.started_at) {
    startCountdownTriggered = true;
    const startedAtMs = Date.parse(res.game.started_at.replace(' ', 'T') + 'Z');
    const serverNowMs = res.game.server_now ? Date.parse(res.game.server_now.replace(' ', 'T') + 'Z') : Date.now();
    const remaining = Math.max(0, startedAtMs - serverNowMs - 1000);
    if (remaining > 200) {
      showStartCountdown(remaining);
    }
  }

  renderTicket(document.getElementById('ticketContainer'), ticketGrid, calledSetGlobal, markedSet, markCell, ticketId);
  renderBoard(document.getElementById('numberBoard'), calledSetGlobal, res.game.current_number);

  // Visible for Lobby/Live/Paused whenever auto-call is on, styled as a
  // full badge only while Paused — Lobby and Live show it as plain text
  // (see .pill-plain) so it stays compact next to the status pill.
  syncAutoCallUi(res.room);
  setCallPace(res.room.auto_call_interval_seconds || 5);

  // Speak the number the moment it changes to a new, real value — every
  // player hears it on their own device the instant their poll picks it up.
  if (res.game.current_number != null && res.game.current_number !== previousCurrentNumber) {
    // Several numbers may have landed since the last snapshot (HTTP fallback or a
    // reconnect): announce each one, in call order, not just the newest.
    const newlyCalled = (res.called_numbers || []).map(Number).filter(n => !previouslyCalled.has(n));
    if (previouslyCalled.size > 0 && newlyCalled.length > 1) speakMissedNumbers(newlyCalled);
    else speakNumber(res.game.current_number);
  }
  previousCurrentNumber = res.game.current_number;

  // update claim buttons (closed prizes, green winner button, Full House bracket)
  syncClaimStateFrom(res);
  refreshClaimButtons();

  // Do not fetch results.php from every ticket render. Ticket snapshots are
  // refreshed on reconnect/gaps; room extras have their own lifecycle/event path.
}

async function fetchRoomExtras(options = {}) {
  const now = Date.now();
  if (roomExtrasInFlight) return roomExtrasInFlight;
  if (!options.fresh && now - roomExtrasLastFetchAt < 500) return;
  roomExtrasLastFetchAt = now;
  roomExtrasInFlight = (async () => {
  // Lifecycle reads must bypass the terminal snapshot cache: a completed room
  // can still acquire rematch_room_code when the host starts another game.
  const res = options.fresh
    ? await apiGetFresh('results.php', { room_code: roomCode })
    : await apiGet('results.php', { room_code: roomCode });
  if (!res.success) return;

  // Pass the same locally-ticking counter that drives the nav-bar timer
  // (rather than letting renderGameDetails recompute independently from
  // Date.now()) so the two never show a different "in progress" duration.
  renderGameDetails(res.room, res.room && !res.room.ended_at ? gameTimerSeconds : undefined);

  // Keep the Full House counter in step with the canonical room snapshot.
  if (res.room && res.room.full_house_total != null) {
    claimState.full_house_total = Number(res.room.full_house_total) || 1;
    claimState.full_house_remaining = Number(res.room.full_house_remaining) || 0;
    roomHasMultiFullHouse = claimState.full_house_total > 1;
    if (claimState.full_house_remaining <= 0 && res.winners.some(w => w.prize_type === 'FULL_HOUSE') && !claimState.prizesWon.includes('FULL_HOUSE')) {
      claimState.prizesWon.push('FULL_HOUSE');
    }
    refreshClaimButtons();
  }

  const winnersList = document.getElementById('winnersList');
  if (res.winners.length === 0) {
    winnersList.innerHTML = '<p class="text-dim small mb-0">No winners yet.</p>';
  } else {
    winnersList.innerHTML = res.winners.map(w => `
      <div class="winner-item">
        <span class="winner-item-prizecol">
          <span class="winner-item-prize">${escapeHtml(winnerListPrizeLabel(w, PRIZE_LABELS[w.prize_type] || w.prize_type, roomHasMultiFullHouse || res.winners.filter(x => x.prize_type === 'FULL_HOUSE').length > 1))}</span>
          ${w.claimed_at ? `<span class="winner-item-time">${escapeHtml(formatLocalTimeSeconds(w.claimed_at))}</span>` : ''}
        </span>
        <span class="winner-item-info">
          <span class="winner-item-name">${escapeHtml(w.winner_name)}</span>
          ${w.winner_email ? `<span class="winner-item-email">${escapeHtml(w.winner_email)}</span>` : ''}
        </span>
      </div>`).join('');
  }
  const isFirstLook = !baselineCaptured;
  baselineCaptured = true;

  if (isFirstLook) {
    // First time we've polled this room this session. If it's already
    // finished (page load / refresh landing on a completed game), or
    // already mid-game with prizes already won, just record what's
    // already there — show the winners list and final state plainly,
    // with no replayed banners/confetti/winner card.
    previousWinnerKeys = new Set(res.winners.map(w => winnerKey(w.prize_type, w.winner_position)));
    if (res.game.status === 'ENDED' || res.room.status === 'COMPLETED') {
      finalWinnersShown = true;
    }
  } else {
    res.winners.forEach(w => {
      if (!previousWinnerKeys.has(winnerKey(w.prize_type, w.winner_position))) {
        announceWinnerOnce(w.winner_name, w.prize_type, w.winner_email, w.winner_position || 1, fullHouseTotalNow());
      }
    });
    previousWinnerKeys = new Set(res.winners.map(w => winnerKey(w.prize_type, w.winner_position)));

    // Once the game is over — every enabled prize actually claimed
    // (GameEngine::checkAndAutoEnd), or the host ended it manually — show
    // one summary banner listing every prize winner instead of relying on
    // the one-at-a-time popups alone. Running out of numbers to call is
    // *not* by itself enough to trigger this. If nobody won anything, end
    // quietly — no voice, no winner card.
    if ((res.game.status === 'ENDED' || res.room.status === 'COMPLETED') && !finalWinnersShown) {
      finalWinnersShown = true;
      if (res.winners.length > 0) {
        scheduleFinalWinnersBanner(res.winners);
      }
    }
  }

  renderPlayersList(document.getElementById('playersList'), res.players);
  handleRematchPrompt(res.room);
  })();
  try { return await roomExtrasInFlight; }
  finally { roomExtrasInFlight = null; }
}

function handleRematchPrompt(room) {
  const overlay = document.getElementById('rematchBanner');
  if (!overlay) return;
  if (room.status !== 'COMPLETED' || !room.rematch_room_code || room.rematch_prompt_pending === false) {
    overlay.classList.add('d-none');
    overlay.classList.remove('rematch-modal-overlay');
    return;
  }
  // rematch_created -> ROOM_STATE_SYNC event triggers one canonical refresh;
  closeFinalWinnersOverlay();
  const newRoomCode = String(room.rematch_room_code);
  if (overlay.dataset.dismissed === newRoomCode) return;
  if (overlay.dataset.roomCode === newRoomCode && !overlay.classList.contains('d-none')) return;
  overlay.dataset.roomCode = newRoomCode;
  overlay.className = 'rematch-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'rematchPromptTitle');
  overlay.innerHTML = `
    <div class="glass rematch-modal-card" role="document">
      <h3 id="rematchPromptTitle">🎮 New match invitation</h3>
      <p>The host started a new match. Would you like to join?</p>
      <p class="small text-dim">Room: ${escapeHtml(newRoomCode)}</p>
      <div class="rematch-invite-actions">
        <button type="button" class="btn btn-success" id="rematchJoinYes">Yes, join</button>
        <button type="button" class="btn btn-outline-secondary" id="rematchJoinNo">Decline</button>
      </div>
    </div>`;
  if (!voicedRematchRooms.has(newRoomCode)) {
    voicedRematchRooms.add(newRoomCode);
    speakPhrase('The host started a new match. Want to join? Press yes or decline.');
  }
  document.getElementById('rematchJoinNo').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Leaving...';
    try {
      const result = (typeof window.housiyRealtimeSend === 'function' && rtConnected)
        ? await window.housiyRealtimeSend('DECLINE_REMATCH', { new_room_code: newRoomCode })
        : await apiPost('room_rematch_decline.php', { room_code: roomCode, new_room_code: newRoomCode });
      if (!result.success) throw new Error(result.error || 'Could not save your rematch decision.');
      overlay.classList.add('d-none');
      overlay.dataset.dismissed = newRoomCode;
      if (typeof window.housiyStopRealtimeRoom === 'function') window.housiyStopRealtimeRoom('rematch declined');
      showToast('You declined the rematch. You have left the room.', 'success');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Decline';
      showToast(error.message || 'Could not decline the rematch.', 'danger');
    }
  });
  document.getElementById('rematchJoinYes').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true; button.textContent = 'Joining...';
    const identity = getStoredIdentity();
    if (!identity) { showToast('Could not find your name/email — rejoin from the home page.', 'danger'); button.disabled = false; button.textContent = 'Yes, join'; return; }
    try {
      const result = await apiPost('room_join.php', { name: identity.name, email: identity.email, room_code: newRoomCode });
      if (!result.success) { showToast(result.error || 'Could not join the new game', 'danger'); button.disabled = false; button.textContent = 'Yes, join'; return; }
      window.location.href = `player.html?room=${encodeURIComponent(newRoomCode)}`;
    } catch (_) { showToast('Could not join the new game. Please try again.', 'danger'); button.disabled = false; button.textContent = 'Yes, join'; }
  });
}

loadTicket();
startRealtime(roomCode, poll);
