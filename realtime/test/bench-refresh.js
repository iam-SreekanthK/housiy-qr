'use strict';
// Per-request cost of the refresh path (ticket.php + results.php), measured sequentially
// (no concurrency, so CPU saturation does not blur it): MySQL-only path vs Redis-cached path.
const { execSync } = require('child_process');
const R = process.env.APP_REDIS || 'http://127.0.0.1:8899', P = process.env.APP_PLAIN || 'http://127.0.0.1:8898';
const MYSQL = process.env.MYSQL_CMD || 'mysql -uroot', DB = process.env.DB_NAME || 'housiy';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = c => execSync(c, { encoding: 'utf8', shell: '/bin/bash' }).trim();
const sql = q => sh(`${MYSQL} ${DB} -N -e "${q}"`);
const Q = () => parseInt(sql("SHOW GLOBAL STATUS LIKE 'Questions'").split('\t')[1], 10);
class C { constructor() { this.jar = {}; }
  async req(base, p, b) { const r = await fetch(base + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: b ? JSON.stringify(b) : undefined });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); this.jar[kv.slice(0, i)] = kv.slice(i + 1); } return r.json(); } }
const N = +(process.env.REQS || 300);
(async () => {
  sql("UPDATE games SET status='ENDED' WHERE status IN ('RUNNING','PAUSED')"); sql('DELETE FROM rate_limit_attempts');
  const host = new C(), p = new C(); const u = Math.random().toString(36).slice(2, 8);
  // auto-call ON + game RUNNING = the most expensive state (countdown query is needed on every request)
  const h = await host.req(R, '/api/room_create.php', { name: 'H', email: `h${u}@b.test`, title: 'RB', max_players: 10, auto_call_enabled: true, auto_call_interval_seconds: 60 });
  const code = h.room.room_code; await p.req(R, '/api/room_join.php', { name: 'P', email: `p${u}@b.test`, room_code: code });
  await host.req(R, '/api/game_start.php', { room_code: code }); await sleep(5600);
  for (let i = 0; i < 15; i++) { await host.req(R, '/api/game_next.php', { room_code: code }); await sleep(120); }
  await sleep(1200);
  for (const [label, base] of [['MySQL-only path  ', P], ['Redis-cached path ', R]]) {
    for (const path of ['ticket', 'results']) {
      const url = `/api/${path}.php?room_code=${code}`; await p.req(base, url); // warm
      const idle0 = Q(); await sleep(1500); const idle = (Q() - idle0 - 1) / 1.5;
      const q0 = Q(); const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) await p.req(base, url);
      const dt = Number(process.hrtime.bigint() - t0) / 1e9; const q1 = Q();
      const stmts = (q1 - q0 - 1 - idle * dt) / N;
      console.log(`${label} ${path.padEnd(8)} statements/request=${stmts.toFixed(2)}  avg_latency=${(dt * 1000 / N).toFixed(1)}ms  (${N} sequential requests)`);
    }
  }
})();
