#!/usr/bin/env node
'use strict';
// Controlled FIRST_FIVE race. Requires a running UAT/dev compose stack and Node 20+.
// Verifies API winner count and, where MYSQL CLI is available in the db container,
// verifies exactly one persisted winner row for this room/prize.
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:80').replace(/\/$/, '');
const TARGET_ENV = (process.env.TARGET_ENV || 'dev').toLowerCase();
// Same safety model as tests/load/config.js: dev/uat only, allow-listed host, and the server
// itself (GET /api/env.php) must confirm it is the environment we think it is.
async function assertSafeTarget() {
  if (!['dev', 'uat'].includes(TARGET_ENV)) throw new Error(`SAFETY: TARGET_ENV must be dev or uat (got ${TARGET_ENV}); production is refused`);
  const allowed = (process.env.LOAD_ALLOWED_HOSTS || '127.0.0.1,localhost,host.docker.internal').split(',').map(s => s.trim());
  const host = new URL(BASE).hostname;
  if (!allowed.includes(host)) throw new Error(`SAFETY: host ${host} not in LOAD_ALLOWED_HOSTS`);
  let env; try { env = (await (await fetch(`${BASE}/api/env.php`)).json()).env; } catch (e) { throw new Error('SAFETY: cannot verify target environment'); }
  if (env === 'prod') throw new Error('SAFETY: target reports prod');
  if (env !== TARGET_ENV) throw new Error(`SAFETY: target reports ${env}, expected ${TARGET_ENV}`);
}
// docker compose project for COMPOSE_ENV_FILE=.../.env.<env>  ->  housiy-<env> (same naming as envctl.sh)
function composeProject(envFile) {
  const m = /\.env\.([a-z]+)$/.exec(envFile);
  if (!m || !['dev', 'uat'].includes(m[1])) throw new Error('SAFETY: COMPOSE_ENV_FILE must be deployment/docker/.env.dev or .env.uat');
  return `housiy-${m[1]}`;
}
const N = Number(process.env.CLAIM_RACE_PLAYERS || 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
let failures = 0;
function client() { return { jar: new Map() }; }
async function api(c, path, body) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: {'content-type':'application/json', cookie:[...c.jar].map(([k,v])=>`${k}=${v}`).join('; ')},
    body: body ? JSON.stringify(body) : undefined
  });
  for (const sc of (res.headers.getSetCookie?.() || [])) {
    const pair = sc.split(';')[0], i = pair.indexOf('=');
    if (i > 0) c.jar.set(pair.slice(0,i), pair.slice(i+1));
  }
  const text = await res.text(); let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${path} returned ${res.status}: ${text.slice(0,180)}`); }
  if (!res.ok && res.status !== 400) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0,180)}`);
  return data;
}
(async () => {
  await assertSafeTarget();
  const host = client(), players = Array.from({length:N}, () => client());
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const created = await api(host, '/api/room_create.php', {name:'Claim Race Host',email:`cr-host-${stamp}@example.test`,title:'Claim Race',max_players:N+1});
  if (!created.success || !created.room?.room_code) throw new Error('Could not create room: '+JSON.stringify(created));
  const room = created.room.room_code;
  const joined = [];
  for (let i=0;i<N;i++) {
    const j = await api(players[i], '/api/room_join.php', {name:`Claim Race ${i}`,email:`cr-${i}-${stamp}@example.test`,room_code:room});
    if (!j.success || !j.ticket?.grid) throw new Error(`Player ${i} could not join: ${JSON.stringify(j)}`);
    joined.push(new Set(j.ticket.grid.flat().filter(Boolean)));
  }
  const started = await api(host, '/api/game_start.php', {room_code:room});
  if (started.success === false) throw new Error('Could not start game: '+JSON.stringify(started));
  // Allow configured game start countdown; default Housiy countdown is five seconds.
  await sleep(Number(process.env.START_COUNTDOWN_MS || 6000));
  // Call numbers until every player has at least five of their ticket numbers called.
  const called = new Set();
  for (let i=0;i<90 && joined.some(nums => [...nums].filter(n=>called.has(n)).length < 5);i++) {
    const n = await api(host, '/api/game_next.php', {room_code:room});
    if (n.success && Number.isInteger(n.number)) called.add(n.number);
    else await sleep(200);
  }
  if (joined.some(nums => [...nums].filter(n=>called.has(n)).length < 5))
    throw new Error('Unable to call enough ticket numbers for all race participants');
  // Each player marks five called numbers on their own ticket. Mark responses for
  // non-ticket numbers are intentionally avoided.
  for (let i=0;i<N;i++) {
    const mine = [...joined[i]].filter(n=>called.has(n)).slice(0,5);
    if (mine.length < 5) throw new Error(`Player ${i} lacks five called ticket numbers`);
    for (const number of mine) {
      const mark = await api(players[i], '/api/mark.php', {room_code:room,number});
      if (mark.success === false) throw new Error(`Mark failed for player ${i}, number ${number}: ${JSON.stringify(mark)}`);
    }
  }
  const claims = await Promise.all(players.map((p) => api(p, '/api/claim.php', {room_code:room,prize_type:'FIRST_FIVE'})));
  const valid = claims.filter(x=>x.valid===true);
  ok(valid.length === 1, `exactly one of ${N} simultaneous valid FIRST_FIVE claims accepted (accepted=${valid.length})`);
  const results = await api(host, `/api/results.php?room_code=${encodeURIComponent(room)}`);
  const winners = (results.winners || []).filter(w=>w.prize_type==='FIRST_FIVE');
  ok(winners.length === 1, `results API has exactly one FIRST_FIVE winner (count=${winners.length})`);
  if (process.env.COMPOSE_ENV_FILE) {
    const {execFileSync} = require('node:child_process');
    const composeFile = 'deployment/docker/docker-compose.yml';
    // Run mysql inside the DB container so credentials/database are read from
    // the container environment; do not place secrets in shell history/arguments.
    const sql = `SELECT COUNT(*) FROM room_prize_winners w JOIN rooms r ON r.id=w.room_id WHERE r.room_code='${room}' AND w.prize_type='FIRST_FIVE'`;
    try {
      const out = execFileSync('docker', ['compose', '--project-name', composeProject(process.env.COMPOSE_ENV_FILE), '--env-file', process.env.COMPOSE_ENV_FILE,
        '-f', composeFile, 'exec', '-T', 'db', 'sh', '-lc',
        `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "${sql}"`],
        {encoding:'utf8', env:process.env}).trim();
      ok(Number(out)===1, `MySQL persisted exactly one FIRST_FIVE award row (count=${out})`);
    } catch (e) {
      console.error('FAIL MySQL persisted-winner verification could not run:', e.message);
      failures++;
    }
  } else {
    console.log('INFO For direct MySQL persistence assertion, set COMPOSE_ENV_FILE=deployment/docker/.env.uat and MYSQL_ROOT_PASSWORD.');
  }
  console.log(`Claim race room=${room}; participants=${N}`);
  process.exit(failures ? 1 : 0);
})().catch(e=>{console.error('ERROR',e.message);process.exit(2)});
