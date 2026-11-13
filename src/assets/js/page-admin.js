let dashboardData = { rooms: [], hosts: [], players: [], users: [] };
let currentTab = 'rooms';
let currentView = 'rooms';
let dashboardLoading = false;
let roomStatusFilter = null; // null | 'LIVE' | 'COMPLETED' — set by clicking a stat card

// Admin timestamps always include seconds (HH:MM:SS) in the viewer's local timezone.
function formatAdminDateTime(value) {
  const d = parseUtcTimestamp(value);
  if (!d) return '—';
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return `${date} ${time}`;
}

function setActiveTab(tab) {
  currentTab = tab; currentView = tab;
  closeRoomDetails();
  ['rooms', 'hosts', 'players'].forEach(t => document.getElementById(`${t}Tab`).classList.toggle('d-none', t !== (tab === 'users' ? 'players' : tab)));
  { const h = document.querySelector('#playersTab thead tr'); if (h) h.innerHTML = tab === 'users' ? '<th>Name</th><th>Email</th><th>User Type</th><th>Joined Date</th>' : '<th>Name</th><th>Email</th><th>Last Joined Room</th><th>Joined Date</th>'; }
  const pdf = document.getElementById('exportPdfBtn'); const excel = document.getElementById('exportExcelBtn');
  if (pdf) pdf.href = `api/admin_export_pdf.php?view=${encodeURIComponent(currentView)}`;
  if (excel) excel.href = `api/admin_export_excel.php?view=${encodeURIComponent(currentView)}`;
  renderActiveTab();
}

document.querySelectorAll('[data-tab]').forEach(btn => btn.remove());

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await apiPost('admin_logout.php', {});
  window.location.href = 'admin_login.html';
});

document.getElementById('searchInput').addEventListener('input', renderActiveTab);
document.getElementById('dateFilter').addEventListener('change', renderActiveTab);
document.getElementById('clearFiltersBtn').addEventListener('click', () => {
  document.getElementById('searchInput').value = '';
  document.getElementById('dateFilter').value = '';
  roomStatusFilter = null;
  renderActiveTab();
});

function statCard(label, value, filter) {
  return `<div class="col-6 col-sm-4 col-md-3 col-xl" style="min-width:0;flex:1 1 0;">
    <div class="glass p-3 text-center card-anim stat-card" data-filter="${filter}" style="cursor:pointer;">
      <div class="fs-3 fw-bold">${value}</div>
      <div class="text-dim small">${label}</div>
    </div>
  </div>`;
}

/** date input gives "YYYY-MM-DD" in the viewer's local calendar — compare
 *  it against the same local date the table already displays (see
 *  formatLocalDateTime), not the raw UTC string. */
function matchesDateFilter(utcString, ymd) {
  if (!ymd) return true;
  const d = parseUtcTimestamp(utcString);
  if (!d) return false;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return local === ymd;
}

function matchesSearch(fields, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some(f => (f || '').toLowerCase().includes(q));
}

function renderActiveTab() {
  const query = document.getElementById('searchInput').value.trim();
  const dateFilter = document.getElementById('dateFilter').value;

  if (currentTab === 'rooms') {
    let rows = dashboardData.rooms;
    if (roomStatusFilter === 'LIVE') rows = rows.filter(r => ['LIVE', 'PAUSED'].includes(r.status));
    if (roomStatusFilter === 'COMPLETED') rows = rows.filter(r => r.status === 'COMPLETED');
    if (roomStatusFilter === 'LOBBY') rows = rows.filter(r => r.status === 'LOBBY');
    rows = rows.filter(r =>
      matchesSearch([r.host_name, r.host_email, r.room_code, r.title], query) &&
      matchesDateFilter(r.created_at, dateFilter)
    );
    renderRoomsBody(rows);
  } else if (currentTab === 'hosts') {
    const rows = dashboardData.hosts.filter(h =>
      matchesSearch([h.name, h.email, h.last_hosted_room_code, h.last_hosted_status], query) && matchesDateFilter(h.last_hosted_at, dateFilter)
    );
    renderHostsBody(rows);
  } else if (currentTab === 'users') {
    const rows = dashboardData.users.filter(u => matchesSearch([u.name, u.email, u.user_type], query) && matchesDateFilter(u.joined_at || u.created_at, dateFilter));
    renderUsersBody(rows);
  } else {
    const rows = dashboardData.players.filter(p =>
      matchesSearch([p.name, p.email, p.last_room_code, p.last_room_status], query) && matchesDateFilter(p.last_joined_at, dateFilter)
    );
    renderPlayersBody(rows);
  }
}

function renderRoomsBody(rows) {
  document.getElementById('roomsBody').innerHTML = rows.length ? rows.map(r => `
    <tr class="room-row" data-room="${escapeHtml(r.room_code)}" style="cursor:pointer;">
      <td><code>${escapeHtml(r.room_code)}</code></td>
      <td>${escapeHtml(r.title)}</td>
      <td>${statusPill(r.status)}</td>
      <td>${escapeHtml(r.host_name)}<br><span class="text-dim small">${escapeHtml(r.host_email)}</span></td>
      <td>${r.player_count} / ${r.max_players}</td>
      <td class="text-dim small">${formatAdminDateTime(r.created_at)}</td>
      <td class="text-dim small">${r.status === 'COMPLETED' && r.started_at && r.ended_at ? formatDuration(r.started_at, r.ended_at) : '—'}</td>
      <td>
        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-outline-glass details-btn" data-room="${escapeHtml(r.room_code)}">Details</button>
          ${['LIVE','PAUSED'].includes(r.status) ? `<button class="btn btn-sm btn-outline-glass end-btn" data-room="${escapeHtml(r.room_code)}">End</button>` : ''}
          <button class="btn btn-sm btn-outline-danger delete-btn" data-room="${escapeHtml(r.room_code)}">Delete</button>
        </div>
      </td>
    </tr>`).join('') : `<tr><td colspan="8" class="text-dim small text-center py-3">No rooms match this filter.</td></tr>`;

  document.querySelectorAll('.end-btn').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`End room ${btn.dataset.room}?`)) return;
    const res = await apiPost('admin_room_end.php', { room_code: btn.dataset.room });
    if (!res.success) showToast(res.error, 'danger'); else { showToast('Room ended', 'success'); loadDashboard(); }
  }));
  document.querySelectorAll('.delete-btn').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Permanently delete room ${btn.dataset.room}? This cannot be undone.`)) return;
    btn.disabled = true;
    const res = await apiPost('admin_room_delete.php', { room_code: btn.dataset.room });
    if (!res.success) { btn.disabled = false; showToast(res.error || 'Room deletion failed', 'danger'); }
    else { showToast('Room deleted', 'success'); closeRoomDetails(); await loadDashboard(); }
  }));
  document.querySelectorAll('.details-btn').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openRoomDetails(btn.dataset.room);
  }));
  document.querySelectorAll('.room-row').forEach(row => row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openRoomDetails(row.dataset.room);
  }));
}

function durationLabel(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '—';
  const n = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(n / 60)}m ${n % 60}s`;
}
function userBlockAction(user) {
  const blocked = Number(user.is_blocked) === 1 || user.is_blocked === true;
  return `<button type="button" class="btn btn-sm ${blocked ? 'btn-outline-success' : 'btn-outline-danger'} user-block-btn"
    data-user-id="${Number(user.id)}" data-blocked="${blocked ? '1' : '0'}">${blocked ? 'Unblock' : 'Block'}</button>`;
}
function bindUserBlockActions(containerSelector) {
  document.querySelectorAll(`${containerSelector} .user-block-btn`).forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const block = btn.dataset.blocked !== '1';
    const action = block ? 'Block' : 'Unblock';
    if (!confirm(`${action} this user? ${block ? 'They will not be able to log in, join, or host games.' : 'They will be able to use Housiy again.'}`)) return;
    btn.disabled = true;
    const res = await apiPost('admin_user_block.php', { user_id: Number(btn.dataset.userId), blocked: block });
    if (!res.success) {
      btn.disabled = false;
      showToast(res.error || `${action} failed`, 'danger');
      return;
    }
    showToast(block ? 'User blocked successfully' : 'User unblocked successfully', 'success');
    await loadDashboard();
  }));
}
function renderHostsBody(rows) {
  const head = document.querySelector('#hostsTab thead tr');
  if (head) head.innerHTML = '<th>Name</th><th>Email</th><th>Rooms Hosted</th><th>Last Hosted Room</th><th>Status</th><th>Duration</th><th>Last Hosted</th><th>Access</th>';
  document.getElementById('hostsBody').innerHTML = rows.length ? rows.map(h => `
    <tr class="user-row" data-email="${escapeHtml(h.email)}" style="cursor:pointer;">
      <td>${escapeHtml(h.name)}</td><td>${escapeHtml(h.email)}</td><td>${h.rooms_hosted}</td>
      <td><code>${escapeHtml(h.last_hosted_room_code || '—')}</code></td>
      <td>${h.last_hosted_status ? statusPill(h.last_hosted_status) : '—'}</td>
      <td class="text-dim small">${h.last_hosted_status === 'COMPLETED' ? durationLabel(h.last_hosted_duration_seconds) : '—'}</td>
      <td class="text-dim small">${formatAdminDateTime(h.last_hosted_at)}</td><td>${userBlockAction(h)}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="text-dim small text-center py-3">No hosts match this filter.</td></tr>';
  document.querySelectorAll('#hostsBody .user-row').forEach(row => row.addEventListener('click', e => { if (!e.target.closest('button')) openUserHistory(row.dataset.email); }));
  bindUserBlockActions('#hostsBody');
}

function renderPlayersBody(rows) {
  const head = document.querySelector('#playersTab thead tr');
  if (head) head.innerHTML = '<th>Name</th><th>Email</th><th>Last Joined Room</th><th>Status</th><th>Duration</th><th>Joined Date</th><th>Access</th>';
  document.getElementById('playersBody').innerHTML = rows.length ? rows.map(p => `
    <tr class="user-row" data-email="${escapeHtml(p.email)}" style="cursor:pointer;">
      <td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.email)}</td><td><code>${escapeHtml(p.last_room_code || '—')}</code></td>
      <td>${p.last_room_status ? statusPill(p.last_room_status) : '—'}</td>
      <td class="text-dim small">${p.last_room_status === 'COMPLETED' ? durationLabel(p.last_room_duration_seconds) : '—'}</td>
      <td class="text-dim small">${formatAdminDateTime(p.last_joined_at)}</td><td>${userBlockAction(p)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="text-dim small text-center py-3">No players match this filter.</td></tr>';
  document.querySelectorAll('#playersBody .user-row').forEach(row => row.addEventListener('click', e => { if (!e.target.closest('button')) openUserHistory(row.dataset.email); }));
  bindUserBlockActions('#playersBody');
}

function renderUsersBody(rows) {
  const head = document.querySelector('#playersTab thead tr');
  if (head) head.innerHTML = '<th>Name</th><th>Email</th><th>User Type</th><th>Joined Date</th><th>Last Joined Room</th><th>Last Hosted Room</th><th>Access</th>'; 
  document.getElementById('playersBody').innerHTML = rows.length ? rows.map(u => `
    <tr class="user-row" data-email="${escapeHtml(u.email)}" style="cursor:pointer;">
      <td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.user_type)}</td>
      <td class="text-dim small">${formatAdminDateTime(u.joined_at || u.created_at)}</td>
      <td><code>${escapeHtml(u.last_joined_room_code || '—')}</code></td>
      <td><code>${escapeHtml(u.last_hosted_room_code || '—')}</code></td>
      <td>${userBlockAction(u)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="text-dim small text-center py-3">No users match this filter.</td></tr>';
  document.querySelectorAll('#playersBody .user-row').forEach(row => row.addEventListener('click', e => { if (!e.target.closest('button')) openUserHistory(row.dataset.email); }));
  bindUserBlockActions('#playersBody');
}

async function loadDashboard() {
  if (dashboardLoading) return;
  dashboardLoading = true;
  let res;
  try { res = await apiGet('admin_dashboard.php'); } catch (e) { dashboardLoading = false; return; }
  dashboardLoading = false;
  if (!res.success) {
    if (res.error && res.error.includes('Admin')) window.location.href = 'admin_login.html';
    return;
  }

  dashboardData = { rooms: res.rooms, hosts: res.hosts, players: res.players, users: res.users || [] };

  document.getElementById('statsRow').innerHTML = [
    statCard('Total Rooms', res.stats.total_rooms, 'rooms:all'),
    statCard('Lobby', res.stats.lobby_rooms || 0, 'rooms:lobby'),
    statCard('Live Now', res.stats.live_rooms, 'rooms:live'),
    statCard('Completed', res.stats.completed_rooms, 'rooms:completed'),
    statCard('Hosts', res.stats.total_hosts || res.hosts.length, 'hosts'),
    statCard('Players', res.stats.total_players, 'players'),
    statCard('Total Users', res.stats.total_users, 'users'),
  ].join('');

  document.querySelectorAll('.stat-card').forEach(card => card.addEventListener('click', () => {
    const filter = card.dataset.filter;
    document.getElementById('searchInput').value = '';
    document.getElementById('dateFilter').value = '';
    roomStatusFilter = null;
    if (filter.startsWith('rooms:')) {
      roomStatusFilter = filter === 'rooms:all' ? null : filter === 'rooms:live' ? 'LIVE' : filter === 'rooms:completed' ? 'COMPLETED' : 'LOBBY';
      setActiveTab('rooms');
    } else if (filter === 'hosts') setActiveTab('hosts');
    else if (filter === 'players') setActiveTab('players');
    else if (filter === 'users') { currentView = 'users'; setActiveTab('users'); }
    const pdf = document.getElementById('exportPdfBtn'); const excel = document.getElementById('exportExcelBtn');
    const exportView = filter === 'users' ? 'users' : currentView;
    const suffix = roomStatusFilter ? `&status=${encodeURIComponent(roomStatusFilter)}` : '';
    if (pdf) pdf.href = `api/admin_export_pdf.php?view=${encodeURIComponent(exportView)}${suffix}`;
    if (excel) excel.href = `api/admin_export_excel.php?view=${encodeURIComponent(exportView)}${suffix}`;
    renderActiveTab();
  }));

  renderActiveTab();
}

/* ------------------------------------------------------------------
 * Room details modal — start/completed time (converted to the admin's
 * own local time zone), how long the game took, and the same player /
 * winner breakdown a host or player sees. Opened from the "Details"
 * button on any room row.
 * ---------------------------------------------------------------- */
const roomDetailsPanel = document.getElementById('roomDetailsPanel');
const roomDetailsBody = document.getElementById('roomDetailsBody');
const roomDetailsTitle = document.getElementById('roomDetailsTitle');

function closeRoomDetails() {
  roomDetailsPanel.classList.add('d-none');
}
document.getElementById('roomDetailsClose').addEventListener('click', closeRoomDetails);

async function openRoomDetails(roomCode) {
  roomDetailsTitle.textContent = `Room ${roomCode}`;
  const exportPdf = document.getElementById('roomDetailsExportPdf');
  const exportExcel = document.getElementById('roomDetailsExportExcel');
  exportPdf.href = `api/admin_export_pdf.php?room_code=${encodeURIComponent(roomCode)}`;
  exportExcel.href = `api/admin_export_excel.php?room_code=${encodeURIComponent(roomCode)}`;
  exportPdf.classList.remove('d-none');
  exportExcel.classList.remove('d-none');
  roomDetailsBody.innerHTML = '<p class="text-dim small mb-0">Loading...</p>';
  roomDetailsPanel.classList.remove('d-none');
  roomDetailsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const res = await apiGet('admin_room_details.php', { room_code: roomCode });
  if (!res.success) {
    roomDetailsBody.innerHTML = `<p class="text-danger small mb-0">${escapeHtml(res.error || 'Failed to load room details.')}</p>`;
    return;
  }

  const r = res.room;
  const started = r.started_at ? formatAdminDateTime(r.started_at) : 'Not started yet';
  const completed = r.ended_at ? formatAdminDateTime(r.ended_at) : (r.status === 'COMPLETED' ? '—' : 'Still in progress');
  const duration = r.started_at && r.ended_at ? formatDuration(r.started_at, r.ended_at) : '—';

  const winnersRows = res.winners.length
    ? res.winners.map((w, i) => `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml((w.prize_type || '').replaceAll('_', ' '))}${(w.prize_type === 'FULL_HOUSE' && Number(r.full_house_winners) > 1) ? ` <span class="text-dim">#${Number(w.winner_position) || 1} of ${Number(r.full_house_winners)}</span>` : ''}</td>
        <td>${escapeHtml(w.winner_name || '—')}</td>
        <td>${escapeHtml(w.winner_email || '—')}</td>
        <td class="text-nowrap">${formatAdminDateTime(w.claimed_at)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="text-dim text-center py-3">No winners yet.</td></tr>';

  const playersRows = res.players.length
    ? res.players.map((p, i) => `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(p.name || '—')}</td>
        <td>${escapeHtml(p.email || '—')}</td>
        <td class="text-nowrap">${formatAdminDateTime(p.joined_at)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="text-dim text-center py-3">No players in this room.</td></tr>';

  roomDetailsBody.innerHTML = `
    <div class="mb-2">${statusPill(r.status)} <span class="text-dim small ms-2">${escapeHtml(r.title)}</span></div>
    <div class="row g-2 mb-3">
      <div class="col-6"><div class="text-dim small">Host</div><div class="small">${escapeHtml(r.host_name)}<br><span class="text-dim">${escapeHtml(r.host_email)}</span></div></div>
      <div class="col-6"><div class="text-dim small">Players</div><div class="small">${r.player_count} / ${r.max_players}</div></div>
      <div class="col-6"><div class="text-dim small">Created</div><div class="small">${formatAdminDateTime(r.created_at)}</div></div>
      <div class="col-6"><div class="text-dim small">Numbers called</div><div class="small">${res.game.numbers_called_count} / 90</div></div>
      <div class="col-6"><div class="text-dim small">Reactions count</div><div class="small">${Number(res.game.reactions_count || 0)}</div></div>
      <div class="col-6"><div class="text-dim small">Start time</div><div class="small">${started}</div></div>
      <div class="col-6"><div class="text-dim small">Completed time</div><div class="small">${completed}</div></div>
      <div class="col-6"><div class="text-dim small">Time taken</div><div class="small">${duration}</div></div>
    </div>
    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
      <h6 class="mb-0">Winners (${res.winners.length})</h6>
    </div>
    <div class="table-responsive mb-4">
      <table class="table table-dark-glass table-sm align-middle">
        <thead><tr><th>#</th><th>Prize</th><th>Winner name</th><th>Email</th><th>Claim time</th></tr></thead>
        <tbody>${winnersRows}</tbody>
      </table>
    </div>
    <h6 class="mb-2">Players in room (${res.players.length})</h6>
    <div class="table-responsive">
      <table class="table table-dark-glass table-sm align-middle">
        <thead><tr><th>#</th><th>Player name</th><th>Email</th><th>Joined at</th></tr></thead>
        <tbody>${playersRows}</tbody>
      </table>
    </div>
  `;
}


function attachEmailMaskChoice(link) {
  if (!link || link.dataset.maskChoiceBound === '1') return;
  link.dataset.maskChoiceBound = '1';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const modal = document.getElementById('emailExportModal');
    const checkbox = document.getElementById('maskExportEmails');
    const confirmBtn = document.getElementById('confirmEmailExport');
    const cancelBtn = document.getElementById('cancelEmailExport');
    if (!modal || !checkbox || !confirmBtn || !cancelBtn) {
      showToast('Email privacy dialog is unavailable.', 'danger');
      return;
    }
    checkbox.checked = true; // privacy-safe default on every export
    modal.classList.remove('d-none');
    const close = () => { modal.classList.add('d-none'); };
    // Bind CSP-safe listeners once; do not assign inline-style onclick handlers.
    if (!cancelBtn.dataset.exportBound) {
      cancelBtn.dataset.exportBound = '1';
      cancelBtn.addEventListener('click', close);
    }
    if (!confirmBtn.dataset.exportBound) {
      confirmBtn.dataset.exportBound = '1';
      confirmBtn.addEventListener('click', () => {
        const active = document.querySelector('[data-export-pending="1"]');
        if (!active) { close(); return; }
        const target = new URL(active.href, window.location.href);
        target.searchParams.set('mask_emails', checkbox.checked ? '1' : '0');
        active.dataset.exportPending = '0';
        close();
        window.open(target.toString(), active.target === '_blank' ? '_blank' : '_self', 'noopener');
      });
    }
    document.querySelectorAll('[data-export-pending="1"]').forEach(el => { el.dataset.exportPending = '0'; });
    link.dataset.exportPending = '1';
  });
}
['exportPdfBtn', 'exportExcelBtn', 'roomDetailsExportPdf', 'roomDetailsExportExcel'].forEach(id => {
  attachEmailMaskChoice(document.getElementById(id));
});

loadDashboard();
// Refresh every 30 seconds instead of every 5 seconds; skip overlapping requests.
setInterval(loadDashboard, 30000);

/* ------------------------------------------------------------------
 * User history — every room a host has hosted, and every room a
 * player has joined, in one place. Opened by clicking a row on the
 * Hosts or Players tab; reuses the same inline panel as room details.
 * ---------------------------------------------------------------- */
async function openUserHistory(email) {
  roomDetailsTitle.textContent = email;
  roomDetailsBody.innerHTML = '<p class="text-dim small mb-0">Loading...</p>';
  roomDetailsPanel.classList.remove('d-none');
  roomDetailsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const res = await apiGet('admin_user_history.php', { email });
  if (!res.success) {
    roomDetailsBody.innerHTML = `<p class="text-danger small mb-0">${escapeHtml(res.error || 'Failed to load user history.')}</p>`;
    return;
  }

  const hostedHtml = res.hosted.length
    ? res.hosted.map(r => `<div class="d-flex justify-content-between align-items-center small py-1 border-bottom border-secondary">
        <span><code>${escapeHtml(r.room_code)}</code> ${escapeHtml(r.title)} ${statusPill(r.status)}</span>
        <span class="text-dim">${r.player_count}/${r.max_players} · ${formatAdminDateTime(r.created_at)}</span>
      </div>`).join('')
    : '<p class="text-dim small mb-0">Never hosted a room.</p>';

  const joinedHtml = res.joined.length
    ? res.joined.map(r => `<div class="d-flex justify-content-between align-items-center small py-1 border-bottom border-secondary">
        <span><code>${escapeHtml(r.room_code)}</code> ${escapeHtml(r.title)} ${statusPill(r.status)} <span class="text-dim">hosted by ${escapeHtml(r.host_name)}</span></span>
        <span class="text-dim">${formatAdminDateTime(r.joined_at)}</span>
      </div>`).join('')
    : '<p class="text-dim small mb-0">Never joined a room.</p>';

  roomDetailsBody.innerHTML = `
    <div class="mb-3"><span class="fw-bold">${escapeHtml(res.user.name)}</span> <span class="text-dim small ms-2">${escapeHtml(res.user.email)}</span></div>
    <h6 class="text-dim small mb-1">Rooms hosted (${res.hosted.length})</h6>
    <div class="mb-3">${hostedHtml}</div>
    <h6 class="text-dim small mb-1">Rooms joined (${res.joined.length})</h6>
    <div>${joinedHtml}</div>
  `;
}
