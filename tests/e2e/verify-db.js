'use strict';
// Independent verification of FINAL MySQL state for every room of a run.
// usage: node verify-db.js <RUN_ID> [results.txt-with-ROOM_RESULT-lines]
// Exit code 0 = every invariant holds for every room.
const fs = require('fs');
const { db, PRIZES } = require('./lib');

const rowNums = (g, i) => g[i].filter((v) => v !== 0);

async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error('usage: verify-db.js <RUN_ID> [k6-output-file]');
  const pool = db();
  const clientView = {};
  if (process.argv[3]) {
    for (const line of fs.readFileSync(process.argv[3], 'utf8').split('\n')) {
      const m = line.match(/ROOM_RESULT (\{.*\})"/);
      if (!m) continue;
      try { const o = JSON.parse(m[1].replace(/\\"/g, '"')); clientView[o.roomCode] = o; } catch (_) {}
    }
  }
  const [rooms] = await pool.query('SELECT * FROM rooms WHERE title LIKE ? ORDER BY id', [`k6-${runId}-%`]);
  const out = { runId, rooms: rooms.length, ok: 0, failed: 0, failures: [], totals: { players: 0, tickets: 0, calls: 0, validClaims: 0, rejectedClaims: 0, marks: 0, duplicateWinnerRows: 0 } };
  const seenCodes = new Set(); const seenTicketOwners = new Set();
  for (const r of rooms) {
    const bad = [];
    const chk = (c, msg) => { if (!c) bad.push(msg); };
    if (seenCodes.has(r.room_code)) bad.push('duplicate room_code'); seenCodes.add(r.room_code);
    const [[g]] = await pool.query('SELECT * FROM games WHERE room_id=?', [r.id]);
    const [players] = await pool.query('SELECT user_id FROM room_players WHERE room_id=?', [r.id]);
    const [tickets] = await pool.query('SELECT * FROM tickets WHERE room_id=?', [r.id]);
    const [called] = await pool.query('SELECT number, sequence_no, called_at FROM called_numbers WHERE game_id=? ORDER BY sequence_no', [g.id]);
    const [claims] = await pool.query('SELECT * FROM winner_claims WHERE room_id=? ORDER BY id', [r.id]);
    const [wins] = await pool.query('SELECT * FROM room_prize_winners WHERE room_id=?', [r.id]);
    const [marks] = await pool.query('SELECT m.ticket_id, m.number FROM marked_numbers m JOIN tickets t ON t.id=m.ticket_id WHERE t.room_id=?', [r.id]);
    const prizes = typeof r.prizes_enabled === 'string' ? JSON.parse(r.prizes_enabled) : r.prizes_enabled;
    const ticketOf = new Map(tickets.map((t) => [t.id, t]));
    const memberIds = new Set(players.map((p) => p.user_id));

    // structure / membership / capacity
    chk(r.status === 'COMPLETED' && r.ended_at, `room status ${r.status}`);
    chk(g.status === 'ENDED', `game status ${g.status}`);
    chk(memberIds.has(r.host_user_id), 'host not a member');
    chk(players.length <= r.max_players, `players ${players.length} > max ${r.max_players}`);
    chk(tickets.length === players.length, `tickets ${tickets.length} != players ${players.length}`);
    for (const t of tickets) {
      chk(memberIds.has(t.user_id), 'ticket for non-member');
      const key = `${r.id}:${t.user_id}`; chk(!seenTicketOwners.has(key), 'duplicate ticket owner'); seenTicketOwners.add(key);
      const grid = typeof t.ticket_grid === 'string' ? JSON.parse(t.ticket_grid) : t.ticket_grid;
      const nums = [].concat(...grid).filter((v) => v);
      chk(nums.length === 15 && new Set(nums).size === 15 && grid.every((row) => row.filter((v) => v).length === 5), `bad ticket ${t.id}`);
      t.grid = grid; t.nums = nums;
    }
    // number history
    chk(called.length === g.numbers_called_count, `called rows ${called.length} != counter ${g.numbers_called_count}`);
    chk(called.every((c, i) => c.sequence_no === i + 1), 'sequence gap');
    chk(new Set(called.map((c) => c.number)).size === called.length, 'repeated number');
    chk(called.length === 0 || g.current_number === called[called.length - 1].number, 'current_number != last called');
    // marks only on own ticket numbers that were called
    const calledSet = new Set(called.map((c) => c.number));
    const marksBy = new Map();
    for (const m of marks) {
      const t = ticketOf.get(m.ticket_id);
      if (!t || !t.nums.includes(m.number) || !calledSet.has(m.number)) bad.push(`illegal mark ${m.number}`);
      if (!marksBy.has(m.ticket_id)) marksBy.set(m.ticket_id, new Set()); marksBy.get(m.ticket_id).add(m.number);
    }
    // claims / winners: exclusivity, cross-room isolation, rules re-derived from DB data
    const validByPrize = {};
    for (const c of claims) {
      chk(c.game_id === g.id, 'claim game mismatch');
      const t = ticketOf.get(c.ticket_id);
      chk(!!t && t.user_id === c.user_id && memberIds.has(c.user_id), 'claim ticket/user/room mismatch');
      if (c.is_valid) (validByPrize[c.prize_type] ||= []).push(c);
    }
    for (const p of PRIZES) {
      const enabled = prizes.includes(p);
      const v = validByPrize[p] || [];
      const w = wins.filter((x) => x.prize_type === p);
      chk(enabled ? v.length === 1 && w.length === 1 : v.length === 0 && w.length === 0, `prize ${p}: valid=${v.length} winners=${w.length}`);
      if (v.length > 1) out.totals.duplicateWinnerRows += v.length - 1;
      if (v.length === 1 && w.length === 1) {
        chk(w[0].winner_claim_id === v[0].id, `prize ${p}: winner row points at a different claim`);
        const c = v[0]; const t = ticketOf.get(c.ticket_id);
        const calledByThen = new Set(called.filter((x) => x.called_at <= c.claimed_at).map((x) => x.number));
        const mk = marksBy.get(c.ticket_id) || new Set();
        const all = (ns) => ns.every((n) => calledByThen.has(n) && mk.has(n));
        let valid;
        if (p === 'FIRST_FIVE') valid = t.nums.filter((n) => calledByThen.has(n) && mk.has(n)).length >= 5;
        else if (p === 'FULL_HOUSE') valid = all(t.nums);
        else valid = all(rowNums(t.grid, { TOP_ROW: 0, MIDDLE_ROW: 1, BOTTOM_ROW: 2 }[p]));
        chk(valid, `prize ${p}: winning claim not justified by called+marked numbers`);
        if (p === 'FULL_HOUSE') chk(PRIZES.slice(0, 4).every((q) => wins.some((x) => x.prize_type === q && x.awarded_at <= w[0].awarded_at)), 'FULL_HOUSE awarded before other prizes');
      }
    }
    // what the client saw must equal what is persisted
    const cv = clientView[r.room_code];
    if (cv) {
      const [wr] = await pool.query('SELECT w.prize_type, u.email FROM room_prize_winners w JOIN winner_claims c ON c.id=w.winner_claim_id JOIN users u ON u.id=c.user_id WHERE w.room_id=?', [r.id]);
      const dbWin = Object.fromEntries(wr.map((x) => [x.prize_type, x.email]));
      chk(JSON.stringify(Object.entries(dbWin).sort()) === JSON.stringify(Object.entries(cv.winners).sort()), 'client-observed winners != MySQL winners');
      chk(cv.players === players.length, `client players ${cv.players} != db ${players.length}`);
      chk(cv.calls === called.length, `client calls ${cv.calls} != db ${called.length}`);
    }
    out.totals.players += players.length; out.totals.tickets += tickets.length; out.totals.calls += called.length;
    out.totals.validClaims += claims.filter((c) => c.is_valid).length; out.totals.rejectedClaims += claims.filter((c) => !c.is_valid).length; out.totals.marks += marks.length;
    if (bad.length) { out.failed++; out.failures.push({ room: r.room_code, problems: bad.slice(0, 8) }); } else out.ok++;
  }
  // cross-room isolation at run level: a user's claims never point to a ticket of another room
  const [[x]] = await pool.query(`SELECT COUNT(*) c FROM winner_claims c JOIN tickets t ON t.id=c.ticket_id JOIN rooms r ON r.id=c.room_id WHERE r.title LIKE ? AND t.room_id<>c.room_id`, [`k6-${runId}-%`]);
  if (x.c) { out.failed++; out.failures.push({ room: '*', problems: [`${x.c} claims reference a ticket from another room`] }); }
  out.clientViewsMatched = Object.keys(clientView).length;
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
  process.exit(out.failed || !rooms.length ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(2); });
