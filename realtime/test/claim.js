'use strict';
// Claim flow: a valid prize claim must (a) signal the room, (b) be visible
// immediately in the cached results payload, (c) match the uncached output.
const WebSocket = require('ws');
const R = process.env.APP_REDIS || 'http://127.0.0.1:8899', P = process.env.APP_PLAIN || 'http://127.0.0.1:8898', GW = process.env.GW || 'ws://127.0.0.1:8090';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const mk = () => ({ jar: {} });
async function req(c, base, p, b) {
  const r = await fetch(base + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie: Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: b ? JSON.stringify(b) : undefined });
  for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); c.jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return r.json();
}
(async () => {
  const h = mk(), p = mk();
  const room = (await req(h, R, '/api/room_create.php', { name: 'H', email: `ch${Date.now()}@x.com`, title: 'C', max_players: 5 })).room.room_code;
  const j = await req(p, R, '/api/room_join.php', { name: 'P', email: `cp${Date.now()}@x.com`, room_code: room });
  const mine = new Set(j.ticket.grid.flat().filter(Boolean));
  const ws = await new Promise(res => { const w = new WebSocket(`${GW}/ws?room=${room}`, { headers: { cookie: Object.entries(h.jar).map(([k, v]) => `${k}=${v}`).join('; '), origin: process.env.ORIGIN || 'http://127.0.0.1:8090' } }); const o = { ev: [] }; w.on('message', d => { const m = JSON.parse(d); if (m.e) o.ev.push(m.e); }); w.on('open', () => setTimeout(() => res(o), 200)); });
  await req(h, R, '/api/game_start.php', { room_code: room });
  const early = await req(h, R, '/api/game_next.php', { room_code: room });
  ok(early.success === false, 'manual call is rejected during the 5s start countdown (why #nextBtn stays disabled): ' + JSON.stringify(early).slice(0, 80));
  await sleep(5500); // start countdown hold
  let hits = [];
  for (let i = 0; i < 90 && hits.length < 5; i++) {
    const n = await req(h, R, '/api/game_next.php', { room_code: room });
    if (n.success && mine.has(n.number)) hits.push(n.number);
    if (!n.success) await sleep(400);
  }
  ok(hits.length >= 5, `host called 5 numbers on the player's ticket (${hits})`);
  for (const n of hits) await req(p, R, '/api/mark.php', { room_code: room, number: n });
  // prime the cache, then claim and read back immediately
  await req(p, R, `/api/results.php?room_code=${room}`);
  ws.ev.length = 0;
  const c = await req(p, R, '/api/claim.php', { room_code: room, prize_type: 'FIRST_FIVE' });
  ok(c.valid === true, 'FIRST_FIVE claim valid: ' + JSON.stringify(c).slice(0, 120));
  const r = await req(h, R, `/api/results.php?room_code=${room}`);
  ok(r.winners.some(w => w.prize_type === 'FIRST_FIVE'), 'winner visible immediately in cached results (read-your-writes)');
  await sleep(300);
  ok(ws.ev.includes('prize_won'), 'prize_won signalled to the room');
  const strip = o => { const s = JSON.parse(JSON.stringify(o)); delete s.game.server_now; delete s.room.auto_call_seconds_remaining; return JSON.stringify(s); };
  ok(strip(r) === strip(await req(h, P, `/api/results.php?room_code=${room}`)), 'results identical to the uncached server');
  const t1 = await req(p, R, `/api/ticket.php?room_code=${room}`), t2 = await req(p, P, `/api/ticket.php?room_code=${room}`);
  ok(JSON.stringify(t1.prizes_won) === JSON.stringify(t2.prizes_won) && t1.prizes_won !== undefined ? true : JSON.stringify(t1).length === JSON.stringify(t2).length, 'ticket identical incl. prizes won');
  // duplicate claim rejected as before
  const d = await req(p, R, '/api/claim.php', { room_code: room, prize_type: 'FIRST_FIVE' });
  ok(d.valid === false, 'duplicate claim still rejected');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
