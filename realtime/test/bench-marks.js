'use strict';
// Measures MySQL statements and latency per mark: original path (no Redis, :8898) vs buffered path (:8899).
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
const uniq = () => Math.random().toString(36).slice(2, 9);
const N = parseInt(process.env.PLAYERS || '30', 10), K = parseInt(process.env.MARKS || '6', 10);

async function setup(base) {
  sql('DELETE FROM rate_limit_attempts');
  const host = new C(); const h = await host.req(base, '/api/room_create.php', { name: 'H', email: `h${uniq()}@x.com`, title: 'B', max_players: 200 }); const code = h.room.room_code;
  const ps = [];
  for (let i = 0; i < N; i++) { if (i % 25 === 24) sql('DELETE FROM rate_limit_attempts'); const c = new C(); const j = await c.req(base, '/api/room_join.php', { name: 'P' + i, email: `p${uniq()}@x.com`, room_code: code }); c.grid = new Set(j.ticket.grid.flat().filter(Boolean)); ps.push(c); }
  await host.req(base, '/api/game_start.php', { room_code: code }); await sleep(5400);
  const called = new Set(); for (let i = 0; i < 40; i++) { const n = await host.req(base, '/api/game_next.php', { room_code: code }); if (n.success) called.add(n.number); else await sleep(300); }
  return { code, ps, called };
}
async function run(label, base, warm) {
  const { code, ps, called } = await setup(base);
  const todo = ps.map(p => [...p.grid].filter(n => called.has(n)).slice(0, K));
  if (warm) for (let i = 0; i < ps.length; i++) await ps[i].req(base, '/api/mark.php', { room_code: code, number: todo[i][0] }); // prime caches
  const startIdx = warm ? 1 : 0;
  // idle baseline over an equal-length window
  const i0 = Q(); await sleep(2000); const idleRate = (Q() - i0 - 1) / 2; // -1 for the status query itself
  const q0 = Q(); const t0 = Date.now(); let n = 0;
  for (let i = 0; i < ps.length; i++) for (let k = startIdx; k < todo[i].length; k++) { const r = await ps[i].req(base, '/api/mark.php', { room_code: code, number: todo[i][k] }); if (r.success) n++; }
  const dt = (Date.now() - t0) / 1000; const q1 = Q();
  const stmts = q1 - q0 - 1 - idleRate * dt;
  console.log(`${label.padEnd(34)} marks=${n}  mysql_statements=${Math.round(stmts)}  per_mark=${(stmts / n).toFixed(2)}  avg_latency=${(dt * 1000 / n).toFixed(1)}ms`);
}
(async () => {
  sql("UPDATE games SET status='ENDED' WHERE status IN ('RUNNING','PAUSED')");
  console.log(`players=${N}, marks/player<=${K}; idle worker polling subtracted`);
  await run('BEFORE (original, no Redis)', P, false);
  await run('AFTER  cold caches (1st mark)', R, false);
  await run('AFTER  warm caches (steady state)', R, true);
  await sleep(2500);
  const rows = sql("SELECT COUNT(*) FROM marked_numbers"); console.log('rows in marked_numbers after flush:', rows);
})();
