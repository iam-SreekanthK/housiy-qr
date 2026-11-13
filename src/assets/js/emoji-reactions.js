/* Room-scoped emoji reactions, completion lock and per-user history.
 *
 * Delivery: while the page's WebSocket (common.js startRealtime) is up, the
 * server pushes committed reaction payloads directly to every intended client.
 * There is no reaction polling heartbeat on a healthy socket. If the socket is
 * unavailable, a bounded 2s HTTP fallback recovers missed reactions; reconnects
 * perform one cursor recovery read. */
(() => {
  const trigger = document.getElementById('reactionTrigger');
  const modal = document.getElementById('reactionModal');
  const layer = document.getElementById('reactionFloatLayer');
  if (!trigger || !modal || !layer) return;
  const close = document.getElementById('reactionClose');
  const grid = document.getElementById('reactionEmojiGrid');
  const playerWrap = document.getElementById('reactionPlayerWrap');
  const playerSelect = document.getElementById('reactionPlayerSelect');
  const sendButton = document.getElementById('reactionSend');
  const historyList = document.getElementById('reactionHistoryList');
  const historyCount = document.getElementById('reactionHistoryCount');
  const historyCard = document.getElementById('reactionHistoryCard');
  const historyToggle = document.getElementById('reactionHistoryToggle');
  const historyContent = historyCard?.querySelector('.room-card-content');
  // Bind the history toggle here explicitly so it works consistently on host/player pages.
  if (historyToggle && historyContent && historyCard) {
    const setHistoryExpanded = (expanded) => {
      historyToggle.setAttribute('aria-expanded', String(expanded));
      historyContent.hidden = !expanded;
      historyCard.classList.toggle('room-card-expanded', expanded);
      historyCard.classList.toggle('room-card-collapsed', !expanded);
    };
    setHistoryExpanded(false);
    historyToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setHistoryExpanded(historyToggle.getAttribute('aria-expanded') !== 'true');
      if (historyToggle.getAttribute('aria-expanded') === 'true') loadHistory();
    });
  }
  const params = new URLSearchParams(location.search);
  let roomCode = '', emoji = '🎉', target = 'everyone', cursor = 0, polling = false, cursorInitialized = false;
  let cursorStorageKey = '';
  function storageGet(key) { try { return sessionStorage.getItem(key); } catch (_) { return null; } }
  function storageSet(key, value) { try { sessionStorage.setItem(key, String(value)); } catch (_) {} }
  function syncCursorKey() {
    refreshRoomCode();
    const nextKey = roomCode ? `housiy:reaction-cursor:${roomCode}` : '';
    if (nextKey && nextKey !== cursorStorageKey) { cursorStorageKey = nextKey; cursorInitialized = false; }
  }
  let completed = false, historyLoading = false, reactionPollTimer = null, historyTimer = null, historyRefreshTimer = null, pollQueueTimer = null;
  let visibleReactionCount = 0, reactionCountKnown = false;
  // Session-scoped cache avoids stale/empty terminal history surviving a new login.
  const historyCacheKey = () => roomCode ? `housiy:completed-reaction-history:v2:${roomCode}` : '';
  function stopReactionTimers() { if (reactionPollTimer) clearInterval(reactionPollTimer); if (historyTimer) clearInterval(historyTimer); if (historyRefreshTimer) clearTimeout(historyRefreshTimer); if (pollQueueTimer) clearTimeout(pollQueueTimer); reactionPollTimer = historyTimer = historyRefreshTimer = pollQueueTimer = null; pollQueued = false; pollAgain = false; }
  const API = 'api/reactions.php';
  const seen = new Set();
  function isCurrentUserSender(senderName) {
    try {
      const identity = JSON.parse(localStorage.getItem('housiy_identity') || 'null');
      return !!identity?.name && String(identity.name).trim().toLocaleLowerCase() === String(senderName || '').trim().toLocaleLowerCase();
    } catch (_) { return false; }
  }
  function reactionLabel(senderName) { return isCurrentUserSender(senderName) ? 'You' : (senderName || 'Player'); }
  function updateReactionCount(value) {
    visibleReactionCount = Math.max(0, Number(value) || 0);
    reactionCountKnown = true;
    if (historyCount) historyCount.textContent = String(visibleReactionCount);
  }
  function incrementReactionCount() { updateReactionCount(visibleReactionCount + 1); }
  function newIdempotencyKey() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID().replace(/-/g, '').toLowerCase();
    const bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  const FAST_POLL_MS = 2000, HISTORY_FAST_MS = 15000, MIN_GAP_MS = 250;
  const live = () => typeof rtConnected !== 'undefined' && rtConnected === true;
  let lastPollAt = 0, pollQueued = false, pollAgain = false;
  let realtimeHelloSeen = false;
  let terminalGraceTimer = null;
  // High-contrast palette: each floating reaction gets one colour for its full animation.
  const nameColours = ['#1565C0', '#7B1FA2', '#C62828', '#00796B', '#AD1457', '#4527A0', '#E65100', '#00695C', '#283593', '#558B2F', '#6A1B9A', '#0277BD'];
  let previousNameColour = -1;
  function randomNameColour() {
    let index = Math.floor(Math.random() * nameColours.length);
    if (nameColours.length > 1 && index === previousNameColour) index = (index + 1 + Math.floor(Math.random() * (nameColours.length - 1))) % nameColours.length;
    previousNameColour = index;
    return nameColours[index];
  }
  function refreshRoomCode() {
    const fromUrl = (params.get('room') || params.get('room_code') || '').trim().toUpperCase();
    const fromDom = (document.getElementById('roomCodeText')?.textContent || document.getElementById('mobileRoomCodeText')?.textContent || '').trim().toUpperCase();
    roomCode = fromUrl || fromDom || roomCode;
    return roomCode;
  }
  function beginTerminalGrace(untilMs = Date.now() + 10000) {
    const deadline = Number(untilMs) || (Date.now() + 10000);
    window.housiyReactionGraceUntil = deadline;
    if (completed) return;
    if (terminalGraceTimer) { clearTimeout(terminalGraceTimer); terminalGraceTimer = null; }
    // Keep the reaction control available briefly so players can congratulate
    // winners after the final claim. The server remains authoritative.
    trigger.disabled = false;
    trigger.setAttribute('aria-disabled', 'false');
    trigger.title = 'Send a final reaction (available for 10 seconds)';
    trigger.setAttribute('aria-label', trigger.title);
    if (sendButton) sendButton.disabled = !roomCode || (target === 'player' && !playerSelect?.value);
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining <= 0) { setCompleted(true); return; }
    terminalGraceTimer = setTimeout(() => {
      terminalGraceTimer = null;
      setCompleted(true);
    }, remaining);
  }
  function syncRoomCompletion(data) {
    if (!data || !['COMPLETED','ENDED','CANCELLED'].includes(String(data.room_status || '').toUpperCase())) return;
    const serverDeadline = Number(data.reaction_grace_until || 0) * 1000;
    if (serverDeadline > Date.now()) beginTerminalGrace(serverDeadline);
    else setCompleted(true);
  }
  function setCompleted(value) {
    completed = Boolean(value);
    if (completed) {
      if (terminalGraceTimer) clearTimeout(terminalGraceTimer);
      terminalGraceTimer = null;
      window.housiyGameTerminal = true;
    }
    trigger.disabled = completed;
    trigger.setAttribute('aria-disabled', String(completed));
    trigger.title = completed ? 'Reactions are disabled because this game has ended' : 'Send emoji reaction';
    trigger.setAttribute('aria-label', trigger.title);
    if (completed) { pollQueued = false; pollAgain = false; hide(); layer.replaceChildren(); stopReactionTimers(); }
    if (sendButton) sendButton.disabled = completed || !roomCode || (target === 'player' && !playerSelect?.value);
  }
  const open = () => { if (completed) return; modal.classList.add('open'); modal.setAttribute('aria-hidden','false'); if (target === 'player') loadPlayers(); };
  const hide = () => { modal.classList.remove('open'); modal.setAttribute('aria-hidden','true'); };
  trigger.addEventListener('click', open);
  close?.addEventListener('click', hide);
  modal.addEventListener('click', e => { if (e.target === modal) hide(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  grid?.addEventListener('click', e => {
    const b = e.target.closest('[data-emoji]'); if (!b || completed) return;
    emoji = b.dataset.emoji;
    grid.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  });
  modal.querySelectorAll('[data-reaction-target]').forEach(b => b.addEventListener('click', () => {
    if (completed) return;
    target = b.dataset.reactionTarget;
    modal.querySelectorAll('[data-reaction-target]').forEach(x => x.classList.toggle('active', x === b));
    playerWrap?.classList.toggle('d-none', target !== 'player');
    if (target === 'player') loadPlayers();
    updateSendState();
  }));
  async function request(url, options) {
    const response = await fetch(url, {credentials:'same-origin', cache:'no-store', ...options});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || 'Reaction service unavailable');
    return data;
  }
  async function loadPlayers() {
    refreshRoomCode();
    if (!roomCode || completed) { if (playerSelect) playerSelect.innerHTML = '<option value="">Reactions unavailable</option>'; updateSendState(); return; }
    const previous = playerSelect.value;
    try {
      const data = await request(`${API}?action=players&room_code=${encodeURIComponent(roomCode)}`);
      playerSelect.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value=''; placeholder.textContent='Choose a player…'; playerSelect.appendChild(placeholder);
      data.players.forEach(p => { const option=document.createElement('option'); option.value=String(p.id); option.textContent=p.name; playerSelect.appendChild(option); });
      if ([...playerSelect.options].some(o => o.value === previous)) playerSelect.value=previous;
      syncRoomCompletion(data);
    } catch (_) {
      playerSelect.replaceChildren(); const o=document.createElement('option'); o.value=''; o.textContent='Unable to load players — retry'; playerSelect.appendChild(o);
    }
    updateSendState();
  }
  function updateSendState() { refreshRoomCode(); if (sendButton) sendButton.disabled = completed || !roomCode || (target === 'player' && !playerSelect?.value); }
  playerSelect?.addEventListener('change', updateSendState);
  sendButton?.addEventListener('click', async () => {
    refreshRoomCode();
    if (completed) return;
    if (!roomCode) { showToast('Room information is missing. Reopen the game from its room link.'); return; }
    const recipientId = target === 'player' ? Number(playerSelect.value) : null;
    if (target === 'player' && !recipientId) { playerSelect.focus(); return; }
    sendButton.disabled = true;
    try {
      // One key is shared by WS and HTTP fallback so an uncertain WS outcome
      // cannot create a duplicate reaction when the browser retries over REST.
      const reactionPayload = {room_code:roomCode, emoji, target, recipient_id:recipientId, idempotency_key:newIdempotencyKey()};
      let sent;
      if (typeof window.housiyRealtimeSend === 'function' && live()) {
        try { sent = await window.housiyRealtimeSend('SEND_EMOJI_REACTION', reactionPayload); }
        catch (err) {
          // Fall back only after the transport has actually gone offline. A
          // server-side command rejection must be shown, not replayed via HTTP.
          if (live()) throw err;
          sent = await request(API, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(reactionPayload)});
        }
      } else {
        sent = await request(API, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(reactionPayload)});
      }
      hide();
      // Render the sender's reaction as soon as the server confirms it. Do not
      // wait for history/poll HTTP requests; the WebSocket echo is deduped by id.
      const sentId = Number(sent.id || 0);
      if (sentId && !seen.has(sentId)) {
        seen.add(sentId);
        incrementReactionCount();
        spawn(emoji, 'You');
      }
      // The socket echo carries the committed reaction payload to all recipients.
      // No follow-up polling request is needed.
      if (historyToggle?.getAttribute('aria-expanded') === 'true') scheduleHistoryRefresh();
    } catch (err) { if (/game has ended|completed|cancelled/i.test(err.message)) setCompleted(true); showToast(err.message || 'Could not send reaction'); }
    finally { updateSendState(); }
  });
  // force=true is used right after the user sends a reaction: it must show at once.
  async function poll(force) {
    syncCursorKey();
    if (completed || (window.housiyGameTerminal && Date.now() >= Number(window.housiyReactionGraceUntil || 0)) || !roomCode || document.hidden) return;
    // A forced read is reserved for initial cursor/reconnect recovery. Ordinary
    // background polling must never run after the shared room socket is healthy.
    if (live() && !force) return;
    if (polling) { if (force) pollAgain = true; return; } // an in-flight poll may predate the new row
    // Coalesce bursts of signals so a busy room cannot hammer the endpoint.
    const wait = MIN_GAP_MS - (Date.now() - lastPollAt);
    if (!force && wait > 0) { if (!pollQueued) { pollQueued = true; pollQueueTimer = setTimeout(() => { pollQueued = false; pollQueueTimer = null; if (!live() && !document.hidden) poll(); }, wait); } return; }
    polling = true; lastPollAt = Date.now();
    let more = false;
    try {
      // Preserve the last delivered reaction ID across Home -> Game navigation.
      // On a first visit, set a visibility-aware baseline so historical reactions do not float again.
      if (!cursorInitialized) {
        const saved = storageGet(cursorStorageKey);
        if (saved !== null && /^\d+$/.test(saved)) {
          cursor = Number(saved);
          cursorInitialized = true;
        } else {
          const baseline = await request(`${API}?action=latest&room_code=${encodeURIComponent(roomCode)}`);
          syncRoomCompletion(baseline);
          cursor = Number(baseline.latest_id || 0);
          storageSet(cursorStorageKey, cursor);
          cursorInitialized = true;
          return;
        }
      }
      if (live() && !force) return;
      const data = await request(`${API}?action=poll&room_code=${encodeURIComponent(roomCode)}&after=${cursor}`);
      more = (data.reactions || []).length >= 30; // a full page: there may be more waiting
      syncRoomCompletion(data);
      for (const reaction of data.reactions || []) {
        if (completed) break;
        const id = Number(reaction.id); if (id <= cursor) continue;
        if (seen.has(id)) { cursor = Math.max(cursor, id); storageSet(cursorStorageKey, cursor); continue; }
        seen.add(id); cursor = Math.max(cursor, id); storageSet(cursorStorageKey, cursor); incrementReactionCount(); spawn(reaction.emoji, reactionLabel(reaction.sender_name)); scheduleHistoryRefresh();
      }
      if (seen.size > 500) seen.clear();
    } catch (_) { /* transient poll errors retry next interval */ }
    finally { polling = false; }
    if (completed || (window.housiyGameTerminal && Date.now() >= Number(window.housiyReactionGraceUntil || 0))) { pollAgain = false; return; }
    if (pollAgain) { pollAgain = false; poll(true); }
    else if (more && !completed) poll();
  }
  function spawn(value, senderName) {
    if (completed) return;
    const el=document.createElement('div'); el.className='reaction-float';
    const icon=document.createElement('span'); icon.className='reaction-float-emoji'; icon.textContent=value;
    const name=document.createElement('span'); name.className='reaction-float-name'; name.textContent=senderName || 'Player';
    name.style.color = randomNameColour();
    el.append(icon,name);
    // Start every reaction in the central safe zone on every recipient's screen,
    // then drift along an independent random path without touching viewport edges.
    const width = window.innerWidth;
    const height = window.innerHeight;
    const safeX = Math.min(96, Math.max(36, width * 0.12));
    const safeY = Math.min(150, Math.max(90, height * 0.16));
    const centerMinX = Math.max(safeX, width * 0.30);
    const centerMaxX = Math.min(width - safeX, width * 0.70);
    const centerMinY = Math.max(safeY, height * 0.30);
    const centerMaxY = Math.min(height - safeY, height * 0.64);
    const randomBetween = (min, max) => min + Math.random() * Math.max(0, max - min);
    el.style.left = randomBetween(centerMinX, centerMaxX) + 'px';
    el.style.top = randomBetween(centerMinY, centerMaxY) + 'px';
    el.style.setProperty('--reaction-x', (Math.random() * 150 - 75) + 'px');
    el.style.setProperty('--reaction-y', (Math.random() * 150 - 75) + 'px');
    el.style.setProperty('--reaction-tilt', (Math.random() * 34 - 17) + 'deg');
    el.style.animationDuration = '10s';
    layer.appendChild(el); el.addEventListener('animationend', () => el.remove());
  }
  function formatTime(timestamp) {
    const d = new Date(Number(timestamp)*1000);
    if (Number.isNaN(d.getTime())) return 'Time unavailable';
    return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  }
  async function loadHistory(cacheOnly = false) {
    if (historyLoading || !roomCode || !historyList) return;
    historyLoading = true;
    try {
      let cached = null;
      try { cached = JSON.parse(sessionStorage.getItem(historyCacheKey()) || 'null'); } catch (_) {}
      let data = null;
      // On page open, render only previously fetched data; do not call the history
      // endpoint until the user expands the panel. Never persist an empty placeholder.
      if (cacheOnly) {
        data = cached && Array.isArray(cached.history) ? cached : { history: [] };
      } else {
        // Explicit expansion (including after completion) must refresh from the server.
        // A terminal room is still allowed to READ its saved history.
        data = await request(`${API}?action=history&room_code=${encodeURIComponent(roomCode)}`);
        try { sessionStorage.setItem(historyCacheKey(), JSON.stringify(data)); } catch (_) {}
      }
      syncRoomCompletion(data);
      const items = Array.isArray(data.history) ? data.history : [];
      updateReactionCount(Number.isFinite(Number(data.history_count)) ? Number(data.history_count) : items.length);
      historyList.replaceChildren();
      if (!items.length) {
        const p = document.createElement('p'); p.className = 'reaction-history-empty';
        p.textContent = cacheOnly ? 'Expand to load reaction history.' : 'No emoji reactions yet.';
        historyList.appendChild(p); return;
      }
      for (const item of items) {
        const sent = item.direction === 'SENT';
        const row = document.createElement('article'); row.className = `reaction-history-item ${sent?'sent':'received'} ${item.audience==='EVERYONE'?'room-wide':'private'}`;
        const em = document.createElement('span'); em.className = 'reaction-history-emoji'; em.textContent = item.emoji;
        const main = document.createElement('div'); main.className = 'reaction-history-main';
        const title = document.createElement('div'); title.className = 'reaction-history-title';
        const tag = document.createElement('span'); tag.className = 'reaction-history-direction'; tag.textContent = sent ? 'SENT' : 'RECEIVED';
        title.append(tag, document.createTextNode(sent ? (item.audience === 'EVERYONE' ? 'To everyone' : `To ${item.other_name}`) : `From ${item.other_name}`));
        const sub = document.createElement('div'); sub.className = 'reaction-history-sub'; sub.textContent = item.audience === 'EVERYONE' ? 'Room-wide reaction' : 'Private reaction';
        main.append(title, sub);
        const time = document.createElement('time'); time.className = 'reaction-history-time'; time.textContent = formatTime(item.created_at);
        const timestamp = new Date(Number(item.created_at) * 1000);
        if (!Number.isNaN(timestamp.getTime())) time.dateTime = timestamp.toISOString();
        row.append(em, main, time); historyList.appendChild(row);
      }
    } catch (_) {
      if (!historyList.children.length) {
        const p = document.createElement('p'); p.className = 'reaction-history-empty';
        p.textContent = 'Reaction history is temporarily unavailable. Expand again to retry.';
        historyList.appendChild(p);
      }
    } finally { historyLoading = false; }
  }
  let toastTimer;
  function showToast(message) { let el=document.getElementById('reactionToast'); if(!el){el=document.createElement('div');el.id='reactionToast';el.className='reaction-toast';document.body.appendChild(el);} el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2600); }
  // Debounce history refreshes: incoming realtime reactions should animate now,
  // but a burst of reactions must not trigger one history request per event.
  function scheduleHistoryRefresh() {
    if (historyToggle?.getAttribute('aria-expanded') !== 'true' || historyRefreshTimer || completed) return;
    historyRefreshTimer = setTimeout(() => {
      historyRefreshTimer = null;
      if (historyToggle?.getAttribute('aria-expanded') === 'true' && !completed) void loadHistory();
    }, 1200);
  }
  function acceptRealtimeReaction(reaction) {
    if (!reaction || completed) return;
    const id = Number(reaction.id || 0);
    if (!id || seen.has(id)) return;
    seen.add(id);
    incrementReactionCount();
    cursor = Math.max(cursor, id);
    cursorInitialized = true;
    if (cursorStorageKey) storageSet(cursorStorageKey, cursor);
    spawn(String(reaction.emoji || ''), reactionLabel(reaction.sender_name));
    scheduleHistoryRefresh();
  }
  // Establish a one-time cursor baseline on page entry. After that, healthy
  // WebSocket delivery is authoritative; cursor polling is reserved for outages
  // and reconnect recovery only.
  async function initializeReactionCursor() {
    syncCursorKey();
    if (cursorInitialized || completed || !roomCode) return;
    const saved = storageGet(cursorStorageKey);
    if (saved !== null && /^\d+$/.test(saved)) { cursor = Number(saved); cursorInitialized = true; return; }
    try {
      const baseline = await request(`${API}?action=latest&room_code=${encodeURIComponent(roomCode)}`);
      if (!cursorInitialized) {
        cursor = Number(baseline.latest_id || 0);
        cursorInitialized = true;
        storageSet(cursorStorageKey, cursor);
      }
      syncRoomCompletion(baseline);
    } catch (_) { /* outage fallback will initialize/recover the cursor */ }
  }
  // Redis Pub/Sub -> WebSocket delivers reaction payloads immediately. The
  // REST cursor endpoint is retained only for explicit recovery, never timer polling.
  function startReactionFallback() {
    if (completed || (window.housiyGameTerminal && Date.now() >= Number(window.housiyReactionGraceUntil || 0)) || live() || reactionPollTimer) return;
    void poll(true);
    reactionPollTimer = setInterval(() => { if (!live() && !document.hidden) void poll(); }, FAST_POLL_MS);
    if (!historyTimer) historyTimer = setInterval(() => { if (!live() && historyToggle?.getAttribute('aria-expanded') === 'true' && !document.hidden) void loadHistory(); }, HISTORY_FAST_MS);
  }
  function stopReactionFallback() {
    if (reactionPollTimer) clearInterval(reactionPollTimer);
    if (historyTimer) clearInterval(historyTimer);
    if (pollQueueTimer) clearTimeout(pollQueueTimer);
    reactionPollTimer = historyTimer = pollQueueTimer = null;
    pollQueued = false;
    pollAgain = false;
  }
  window.addEventListener('housiy:realtime', e => {
    const detail = e.detail || {}, type = detail.type;
    if (type === 'fallback') { startReactionFallback(); return; }
    if (type === 'connected' || type === 'hello') stopReactionFallback();
    if (type === 'game_started') {
      if (terminalGraceTimer) clearTimeout(terminalGraceTimer);
      terminalGraceTimer = null;
      completed = false;
      window.housiyGameTerminal = false;
      updateSendState();
    }
    if (type === 'terminal' || type === 'game_ended') { beginTerminalGrace(); return; }
    if (completed) return;
    if (type === 'reaction') {
      if (detail.reaction) acceptRealtimeReaction(detail.reaction);
      // A payload-less legacy signal is ignored; new gateways always send the committed payload.
      return;
    }
    if ((type === 'player_joined' || type === 'player_left') && modal.classList.contains('open') && target === 'player') loadPlayers();
    if (type === 'hello') {
      if (realtimeHelloSeen) void poll(true); // recover only events possibly missed during a reconnect
      realtimeHelloSeen = true;
    }
    if (type === 'game_ended') { /* terminal snapshot is handled by the shared manager */ }
  });
  async function loadReactionCount() {
    refreshRoomCode();
    if (!roomCode) return;
    try {
      const data = await request(`${API}?action=count&room_code=${encodeURIComponent(roomCode)}`);
      updateReactionCount(data.history_count);
      syncRoomCompletion(data);
    } catch (_) { /* live event deltas will update the count; expand performs an exact refresh */ }
  }
  async function bootReactions() {
    refreshRoomCode();
    // Check the local terminal snapshot before making any reaction API calls.
    // This prevents players/history/poll requests when reopening a completed game.
    let cachedTerminal = false;
    try { cachedTerminal = typeof housiyHasCachedTerminalState === 'function' && await housiyHasCachedTerminalState(roomCode); } catch (_) {}
    if (cachedTerminal || window.housiyGameTerminal) {
      // A cached terminal page may still be inside the server's ten-second
      // celebration window. Ask the lightweight count endpoint for the exact
      // server deadline; if offline, honour only a known local deadline.
      await loadReactionCount();
      if (!completed) {
        const deadline = Number(window.housiyReactionGraceUntil || 0);
        if (deadline > Date.now()) beginTerminalGrace(deadline);
        else setCompleted(true);
      }
      await loadHistory(true); // render local history only; never fetch history on a completed room
      return;
    }
    updateSendState();
    await Promise.allSettled([loadHistory(true), initializeReactionCursor(), loadReactionCount()]);
    // The first API response may reveal that the game was completed without a
    // prior local cache. In that case setCompleted() stops these timers below.
    if (completed || window.housiyGameTerminal) return;
    // No background reaction or history polling. Incoming reactions arrive on
    // the room socket; history is loaded only when the user expands the card.
  }
  window.addEventListener('housiy:realtime', e => {
    if (e.detail && e.detail.type === 'terminal') beginTerminalGrace();
  });
  bootReactions();
  document.addEventListener('visibilitychange',()=>{
    if (document.hidden) return;
    if (!completed && !window.housiyGameTerminal && !live() && reactionPollTimer) void poll(true);
  });
})();
