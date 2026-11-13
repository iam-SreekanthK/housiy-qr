'use strict';
// Realtime delivery + isolation + reconnect + winner-race tests against a real stack (dev/uat only).
//   BASE_URL=http://127.0.0.1:80 TARGET_ENV=dev DB_* node realtime-race.js
// The WebSocket gateway carries only "room changed" signals; clients re-fetch state over HTTP, so
// "delivery" here = signal arrives on the right sockets only, AND the state fetched on receipt
// already reflects the committed change (never a notification that precedes the commit).
const WebSocket = require('ws');
const { BASE_URL, PRIZES, assertSafeTarget, db, Client, sleep, ipFor } = require('./lib');

const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';
const RUN = process.env.RUN_ID || `rt${Date.now().toString(36)}`;
const results = []; let failed = 0;
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); if (!cond) failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null;

async function mkRoom(idx, nPlayers) {
  const host = new Client(`host${idx}`, ipFor(500 + idx, 0));
  const c = await host.req('POST', '/api/room_create.php', { name: host.name, email: host.email, title: `k6-${RUN}-${idx}`, max_players: Math.max(2, nPlayers) });
  if (c.status !== 200) throw new Error(`create ${c.status} ${JSON.stringify(c.json)}`);
  const code = c.json.room.room_code;
  const t = await host.req('GET', `/api/ticket.php?room_code=${code}`);
  host.grid = t.json.ticket.grid; host.nums = [].concat(...host.grid).filter(Boolean);
  const players = [host];
  await Promise.all(Array.from({ length: nPlayers - 1 }, async (_, i) => {
    const p = new Client(`p${idx}x${i}`, ipFor(500 + idx, i + 1));
    const j = await p.req('POST', '/api/room_join.php', { name: p.name, email: p.email, room_code: code });
    if (j.status !== 200) throw new Error(`join ${j.status}`);
    p.grid = j.json.ticket.grid; p.nums = [].concat(...p.grid).filter(Boolean); players.push(p);
  }));
  return { code, host, players };
}

function openWs(room, client, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}?room=${room}`, { headers: { cookie: client.cookie, origin: origin || BASE_URL } });
    const o = { ws, events: [], status: null, open: false };
    ws.on('message', (d) => { try { const m = JSON.parse(String(d)); if (m.t === 'u') o.events.push({ e: m.e, at: Date.now() }); } catch (_) {} });
    ws.on('open', () => { o.open = true; resolve(o); });
    ws.on('unexpected-response', (_q, res) => { o.status = res.statusCode; resolve(o); });
    ws.on('error', () => { if (!o.open && o.status === null) { o.status = 0; resolve(o); } });
  });
}

(async () => {
  await assertSafeTarget();
  const pool = db();

  // ---------- realtime: two independent rooms ----------
  const A = await mkRoom(1, 6), B = await mkRoom(2, 6);
  const wsA = await Promise.all(A.players.map((p) => openWs(A.code, p)));
  const wsB = await Promise.all(B.players.map((p) => openWs(B.code, p)));
  ok('all room-A and room-B players connect over WebSocket', [...wsA, ...wsB].every((s) => s.open), `A=${wsA.filter(s => s.open).length}/6 B=${wsB.filter(s => s.open).length}/6`);
  const outsider = new Client('outsider', ipFor(520, 1)); await outsider.req('POST', '/api/room_create.php', { name: 'O', email: outsider.email, title: `k6-${RUN}-out` });
  const wsX = await openWs(A.code, outsider);
  ok('a user who is not in room A cannot subscribe to room A (no cross-room subscription)', wsX.status === 401 || wsX.status === 403, `status=${wsX.status}`);
  const wsAnon = await openWs(A.code, new Client('anon', ipFor(521, 1)));
  ok('unauthenticated WebSocket upgrade is rejected', wsAnon.status === 401, `status=${wsAnon.status}`);
  const wsEvil = await openWs(A.code, A.players[1], 'https://evil.example');
  ok('cross-origin WebSocket upgrade is rejected', wsEvil.status === 403, `status=${wsEvil.status}`);

  ok('host starts room A', (await A.host.req('POST', '/api/game_start.php', { room_code: A.code })).status === 200);
  await sleep(5800);
  const lat = []; let committedBeforeNotify = true; let seqA = 0;
  for (let k = 1; k <= 5; k++) {
    const t0 = Date.now();
    const r = await A.host.req('POST', '/api/game_next.php', { room_code: A.code });
    seqA = r.json.sequence;
    await sleep(350);
    for (const s of wsA) {
      const ev = s.events.filter((e) => e.e === 'number_called');
      if (ev.length < k) { committedBeforeNotify = false; continue; }
      lat.push(ev[k - 1].at - t0);
    }
    await sleep(150);
  }
  ok('every room-A socket received a number_called signal for each of 5 calls', wsA.every((s) => s.events.filter((e) => e.e === 'number_called').length >= 5), `per-socket=${wsA.map((s) => s.events.filter((e) => e.e === 'number_called').length).join(',')}`);
  ok('room-B sockets received NO events from room A activity', wsB.every((s) => s.events.length === 0), `B events=${wsB.reduce((n, s) => n + s.events.length, 0)}`);
  const dup = wsA.map((s) => s.events.filter((e) => e.e === 'number_called').length - 5);
  ok('no duplicated number_called signals', dup.every((d) => d <= 0), `extra=${dup.join(',')}`);
  console.log(`      signal latency (call request -> socket receive) p50=${pct(lat, .5)}ms p95=${pct(lat, .95)}ms max=${Math.max(...lat)}ms n=${lat.length}`);
  // state fetched on receipt is already committed
  const view = await A.players[2].req('GET', `/api/results.php?room_code=${A.code}`);
  ok('state fetched after a signal already contains the committed call count', view.json.game.numbers_called_count === seqA, `${view.json.game.numbers_called_count} vs ${seqA}`);

  // reconnect: drop a socket, change state, reconnect, recover authoritative state
  wsA[3].ws.terminate(); await sleep(200);
  await A.host.req('POST', '/api/game_next.php', { room_code: A.code }); seqA++;
  const re = await openWs(A.code, A.players[3]);
  const rv = await A.players[3].req('GET', `/api/results.php?room_code=${A.code}`);
  ok('reconnect succeeds and authoritative state includes the call made while disconnected', re.open && rv.json.game.numbers_called_count === seqA, `count=${rv.json.game.numbers_called_count} expected=${seqA}`);

  // WebSocket handshake throttling (per user): bounded, not unlimited
  let throttled = 0, accepted = 0;
  const flood = new Client('flood', ipFor(530, 1)); await flood.req('POST', '/api/room_create.php', { name: 'F', email: flood.email, title: `k6-${RUN}-flood` });
  const fr = (await flood.req('POST', '/api/room_create.php', { name: 'F', email: flood.email, title: `k6-${RUN}-flood2` })).json.room.room_code;
  const opened = [];
  for (let i = 0; i < 40; i++) { const s = await openWs(fr, flood); if (s.open) { accepted++; opened.push(s); } else if (s.status === 429) throttled++; }
  opened.forEach((s) => s.ws.terminate());
  ok('WebSocket handshakes are rate limited per user (40 rapid attempts)', throttled > 0 && accepted <= 30, `accepted=${accepted} throttled(429)=${throttled}`);
  [...wsA, ...wsB, re].forEach((s) => { try { s.ws.terminate(); } catch (_) {} });

  // ---------- winner race: many players become eligible, ALL claim at once ----------
  for (let rr = 0; rr < 3; rr++) {
    const N = 30; const R = await mkRoom(10 + rr, N);
    await R.host.req('POST', '/api/game_start.php', { room_code: R.code }); await sleep(5800);
    const called = new Set(); let eligibleCount = 0, claimers = [];
    for (let k = 0; k < 90 && eligibleCount < 20; k++) {
      const n = (await R.host.req('POST', '/api/game_next.php', { room_code: R.code })).json.number; called.add(n);
      await Promise.all(R.players.filter((p) => p.nums.includes(n)).map(async (p) => { const m = await p.req('POST', '/api/mark.php', { room_code: R.code, number: n }); if (m.status === 200) p.marks.add(n); }));
      claimers = R.players.filter((p) => p.nums.filter((x) => called.has(x) && p.marks.has(x)).length >= 5);
      eligibleCount = claimers.length; await sleep(600);
    }
    const res = await Promise.all(claimers.map((p) => p.req('POST', '/api/claim.php', { room_code: R.code, prize_type: 'FIRST_FIVE' })));
    const valid = res.filter((r) => r.status === 200 && r.json && r.json.valid === true).length;
    const rejectedOk = res.filter((r) => r.status === 200 && r.json && r.json.valid === false).length;
    const [[w]] = await pool.query('SELECT COUNT(*) c FROM room_prize_winners w JOIN rooms r ON r.id=w.room_id WHERE r.room_code=? AND w.prize_type="FIRST_FIVE"', [R.code]);
    const [[v]] = await pool.query('SELECT COUNT(*) c FROM winner_claims c JOIN rooms r ON r.id=c.room_id WHERE r.room_code=? AND c.prize_type="FIRST_FIVE" AND c.is_valid=1', [R.code]);
    ok(`race ${rr + 1}: ${claimers.length} eligible players claim FIRST_FIVE simultaneously -> exactly one valid (HTTP)`, valid === 1 && rejectedOk === claimers.length - 1, `valid=${valid} rejected=${rejectedOk} other=${claimers.length - valid - rejectedOk}`);
    ok(`race ${rr + 1}: MySQL holds exactly 1 winner row and 1 valid claim`, w.c === 1 && v.c === 1, `winnerRows=${w.c} validClaims=${v.c}`);
    await R.host.req('POST', '/api/game_end.php', { room_code: R.code });
  }
  await pool.end();
  console.log(JSON.stringify({ runId: RUN, total: results.length, failed }));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('E2E ERROR', e.message); process.exit(2); });
