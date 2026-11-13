'use strict';
// End-to-end check against a running stack (see README). Needs:
//   APP_REDIS (php with Redis, default :8899), APP_PLAIN (php without Redis, :8898), GW (:8090)
const WebSocket = require('ws');
const REDIS = process.env.APP_REDIS || 'http://127.0.0.1:8899';
const PLAIN = process.env.APP_PLAIN || 'http://127.0.0.1:8898';
const GW = process.env.GW || 'ws://127.0.0.1:8090';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(name) { this.name = name; this.cookie = {}; }
  async req(base, path, body) {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', cookie: Object.entries(this.cookie).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); this.cookie[kv.slice(0, i)] = kv.slice(i + 1); }
    return res.json();
  }
  cookieHeader() { return Object.entries(this.cookie).map(([k, v]) => `${k}=${v}`).join('; '); }
  ws(room, origin = process.env.ORIGIN || 'http://127.0.0.1:8090') {
    return new Promise((resolve) => {
      const w = new WebSocket(`${GW}/ws?room=${room}`, { headers: { cookie: this.cookieHeader(), origin } });
      const c = { events: [], hello: null, closed: false, status: null, w };
      w.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'hello') c.hello = m; else c.events.push(m.e); });
      w.on('close', () => { c.closed = true; });
      w.on('unexpected-response', (_r, res) => { c.status = res.statusCode; resolve(c); });
      w.on('error', () => {});
      w.on('open', () => setTimeout(() => resolve(c), 150));
    });
  }
}
const strip = (o) => { const s = JSON.parse(JSON.stringify(o)); if (s.game) delete s.game.server_now; if (s.room) delete s.room.auto_call_seconds_remaining; return JSON.stringify(s); };

(async () => {
  const host = new Client('host'), player = new Client('player'), outsider = new Client('outsider');
  const h = await host.req(REDIS, '/api/room_create.php', { name: 'Host', email: `h${Date.now()}@x.com`, title: 'E2E', max_players: 10, auto_call_enabled: true, auto_call_interval_seconds: 3 });
  const code = h.room.room_code; ok(h.success, 'room created ' + code);

  const hostWs = await host.ws(code);
  ok(hostWs.hello && hostWs.hello.hb === 10000, 'host WS accepted, hello carries heartbeat');
  ok((await outsider.ws(code)).status === 401, 'unauthenticated user rejected (401)');
  ok((await host.ws(code, 'http://evil.example')).status === 403, 'foreign Origin rejected (403)');
  ok((await host.ws('bad!')).status === 400, 'malformed room rejected (400)');

  const j = await player.req(REDIS, '/api/room_join.php', { name: 'Player', email: `p${Date.now()}@x.com`, room_code: code });
  ok(j.success, 'player joined');
  const playerWs = await player.ws(code);
  ok(playerWs.hello !== null, 'player WS accepted');
  await sleep(300);
  ok(hostWs.events.includes('player_joined'), 'host got player_joined signal');

  // outsider who has an identity but is not in the room cannot subscribe
  await outsider.req(REDIS, '/api/room_create.php', { name: 'Other', email: `o${Date.now()}@x.com`, title: 'x', max_players: 5 });
  ok((await outsider.ws(code)).status === 401, 'authenticated non-member rejected');

  // equivalence of cached vs uncached read models
  const same = async (label) => {
    for (const [c, nm] of [[host, 'host'], [player, 'player']]) {
      // The worker may legitimately call a number between the two requests, so
      // sandwich the cached read between two uncached ones: it must equal one of them.
      // A read that lands in the few ms between the worker's MySQL commit and its
      // cache-version bump is allowed to be one step behind; it must converge on
      // the next attempt (persistent staleness is what this check is for).
      let same_ = false, a, b0, b1;
      for (let attempt = 0; attempt < 8 && !same_; attempt++) { // > 1 worker tick (the plain server triggers due auto-calls itself, the Redis one waits for the worker)
        if (attempt) await sleep(200);
        b0 = await c.req(PLAIN, `/api/results.php?room_code=${code}`);
        a = await c.req(REDIS, `/api/results.php?room_code=${code}`);
        b1 = await c.req(PLAIN, `/api/results.php?room_code=${code}`);
        same_ = strip(a) === strip(b0) || strip(a) === strip(b1);
      }
      if (!same_) console.log('DIFF', JSON.stringify(a.game), JSON.stringify(b0.game), JSON.stringify(b1.game), a.called_numbers.length, b0.called_numbers.length, b1.called_numbers.length);
      ok(same_, `${label}: results.php identical with/without Redis (${nm})`);
      const ta = await c.req(REDIS, `/api/ticket.php?room_code=${code}`), tb = await c.req(PLAIN, `/api/ticket.php?room_code=${code}`);
      ok(strip(ta) === strip(tb), `${label}: ticket.php identical with/without Redis (${nm})`);
    }
  };
  await same('lobby');

  hostWs.events.length = 0; playerWs.events.length = 0;
  const st = await host.req(REDIS, '/api/game_start.php', { room_code: code });
  ok(st.success, 'game started');
  await sleep(300);
  ok(hostWs.events.includes('game_started') && playerWs.events.includes('game_started'), 'both got game_started');
  await same('running');

  // auto-call driven by the worker, with NO polling at all
  const t0 = Date.now();
  await sleep(14000);
  const calls = hostWs.events.filter(e => e === 'number_called').length;
  ok(calls >= 3, `worker auto-called with zero polling (${calls} number_called signals in ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  ok(playerWs.events.filter(e => e === 'number_called').length === calls, 'player received the same number_called signals');
  const r = await host.req(REDIS, `/api/results.php?room_code=${code}`);
  ok(r.game.numbers_called_count === calls, `server state matches signals (${r.game.numbers_called_count} numbers)`);
  await same('after auto-calls');

  // mark signals are private to the marking user
  const t = await player.req(REDIS, `/api/ticket.php?room_code=${code}`);
  // pick a number that is both called and actually on this player's ticket
  const onTicket = new Set(t.ticket.grid.flat().filter(Boolean));
  let called = r.called_numbers.find(n => onTicket.has(n));
  for (let i = 0; called === undefined && i < 60; i++) {
    await host.req(REDIS, '/api/game_next.php', { room_code: code });
    called = (await host.req(REDIS, `/api/results.php?room_code=${code}`)).called_numbers.find(n => onTicket.has(n));
  }
  hostWs.events.length = 0; playerWs.events.length = 0;
  const mk = await player.req(REDIS, '/api/mark.php', { room_code: code, number: called });
  await sleep(300);
  ok(mk.success && playerWs.events.includes('ticket_marked') && !hostWs.events.includes('ticket_marked'), 'ticket_marked goes only to the marking user');

  hostWs.events.length = 0;
  await host.req(REDIS, '/api/game_pause.php', { room_code: code }); await sleep(250);
  ok(hostWs.events.includes('game_paused'), 'pause signalled');
  const n1 = (await host.req(REDIS, `/api/results.php?room_code=${code}`)).game.numbers_called_count;
  await sleep(4500);
  const n2 = (await host.req(REDIS, `/api/results.php?room_code=${code}`)).game.numbers_called_count;
  ok(n1 === n2, 'no auto-calls while paused');
  await host.req(REDIS, '/api/game_resume.php', { room_code: code }); await sleep(250);
  ok(hostWs.events.includes('game_resumed'), 'resume signalled');
  await same('resumed');
  await host.req(REDIS, '/api/game_end.php', { room_code: code }); await sleep(300);
  ok(hostWs.events.includes('game_ended') && playerWs.events.includes('game_ended'), 'end signalled to everyone');
  const fin = await player.req(REDIS, `/api/results.php?room_code=${code}`);
  ok(fin.room.status === 'COMPLETED', 'room COMPLETED');
  await same('completed');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
