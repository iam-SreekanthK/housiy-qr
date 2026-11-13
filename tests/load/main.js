// Housiy load test - single entry point for all scenarios.
//
// Usage (see the root LoadTest.md for the real-container load-test guide):
//   k6 run tests/load/main.js                        # smoke (default)
//   k6 run -e SCENARIO=load   tests/load/main.js
//   k6 run -e SCENARIO=stress tests/load/main.js
//   k6 run -e SCENARIO=soak   tests/load/main.js
//   k6 run -e SCENARIO=results tests/load/main.js     # dedicated repeated Results endpoint test
//   k6 run -e SCENARIO=all    tests/load/main.js      # all four, one after another
//
// Every scenario drives the same playFullGame() flow from lib/gameFlow.js
// (room create -> players join -> start -> call/mark numbers -> claim ->
// end -> results), so results are directly comparable across scenarios.

import { sleep } from 'k6';
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { playFullGame } from './lib/gameFlow.js';
import { playRoom, createClient, api } from './lib/game.js';
import { BASE_URL, ROOMS, PLAYERS_PER_ROOM, TARGET_ENV, assertSafeTarget, randomEmail, simIp } from './config.js';

const SCENARIO = __ENV.SCENARIO || 'smoke';

// --- Scenario definitions -------------------------------------------------
// smoke : 1-2 VUs, a handful of iterations - "does the flow work at all".
// load  : ramps to a realistic concurrent-room count and holds it.
// stress: ramps well past expected capacity to find the breaking point.
// soak  : moderate load held for a long duration to catch leaks/degradation.
// results: each iteration creates a real room, completes the game, then repeats
//          GET /api/results.php against the actual room code returned by the API.
const SCENARIOS = {
  smoke: {
    executor: 'per-vu-iterations',
    vus: 2,
    iterations: 2,
    maxDuration: '2m',
  },
  results: {
    executor: 'per-vu-iterations',
    vus: Math.max(1, parseInt(__ENV.RESULTS_VUS || '2', 10)),
    iterations: Math.max(1, parseInt(__ENV.RESULTS_ITERATIONS || '2', 10)),
    maxDuration: __ENV.MAX_DURATION || '10m',
  },
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 10 },
      { duration: '2m', target: 10 },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '15s',
  },
  load30: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 10 },
      { duration: '30s', target: 20 },
      { duration: '30s', target: 30 },
      { duration: '2m', target: 30 },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '30s',
  },
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 10 },
      { duration: '1m', target: 30 },
      { duration: '1m', target: 60 },
      { duration: '2m', target: 60 },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '30s',
  },
  soak: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 15 },
      { duration: '20m', target: 15 },
      { duration: '1m', target: 0 },
    ],
    gracefulRampDown: '30s',
  },
};

// Full multiplayer games: ROOMS concurrent rooms x PLAYERS_PER_ROOM players, one game per VU.
// Presets only fill in defaults; -e ROOMS / -e PLAYERS_PER_ROOM always win.
const PRESETS = { fullgame_smoke: [1, 3], multiroom: [5, 10], normal: [10, 25], players100: [10, 100], stress25x100: [25, 100], capacity: [100, 100], rooms100players100: [100, 100] };
const preset = PRESETS[SCENARIO];
const G_ROOMS = __ENV.ROOMS ? ROOMS : (preset ? preset[0] : ROOMS);
const G_PLAYERS = __ENV.PLAYERS_PER_ROOM ? PLAYERS_PER_ROOM : (preset ? preset[1] : PLAYERS_PER_ROOM);

const rateLimitSecurity = new Counter('housiy_ratelimit_assertions_failed');

export function fullGame() {
  // roomIdx differs per VU AND per iteration so simulated client addresses never repeat across cycles
  playRoom((__VU - 1) + (__ITER * G_ROOMS), G_PLAYERS);
}

// Rate-limit security: exact-limit, atomicity, identity isolation, spoofing, Retry-After, recovery.
export function rateLimit() {
  const t = String(Date.now());
  const fail = (what) => { rateLimitSecurity.add(1); console.error(`RATELIMIT_ASSERT_FAILED ${what}`); };
  const par = (n, mk) => http.batch(Array.from({ length: n }, (_, i) => mk(i)));
  const post = (path, body, ip) => ({ method: 'POST', url: `${BASE_URL}${path}`, body: JSON.stringify(body),
    params: { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, responseCallback: http.expectedStatuses(200, 404, 401, 429) } });
  const count = (rs, s) => rs.filter((r) => r.status === s).length;

  // A. in-limit request works
  const okRes = http.post(`${BASE_URL}/api/room_create.php`, JSON.stringify({ name: 'RL ok', email: randomEmail('rl.ok'), title: `k6-rl-${t}` }),
    { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': simIp(900, 1) }, responseCallback: http.expectedStatuses(200) });
  if (!check(okRes, { 'in-limit create is 200': (r) => r.status === 200 })) fail('A in-limit');

  // B. per-user limit (room_join_user): 40 PARALLEL joins, one e-mail, 40 distinct client IPs => exactly `lim` pass
  const lim = parseInt(__ENV.RL_JOIN_USER_LIMIT || '30', 10);
  const email = randomEmail('rl.user');
  const rsB = par(40, (i) => post('/api/room_join.php', { name: 'RL', email, room_code: 'ZZZZZZZZ' }, simIp(901, i)));
  if (count(rsB, 404) !== lim || count(rsB, 429) !== 40 - lim) fail(`B atomic user limit: 404=${count(rsB, 404)} 429=${count(rsB, 429)} expected ${lim}/${40 - lim}`);
  const r429 = rsB.find((r) => r.status === 429);
  if (!r429 || !/^\d+$/.test(String(r429.headers['Retry-After'] || '')) || r429.json('success') !== false || !r429.json('error')) fail('G 429 shape/Retry-After');

  // E. a different identity is unaffected
  const rsE = par(1, () => post('/api/room_join.php', { name: 'RL', email: randomEmail('rl.other'), room_code: 'ZZZZZZZZ' }, simIp(902, 1)));
  if (rsE[0].status !== 404) fail(`E other identity blocked: ${rsE[0].status}`);

  // C. per-IP limit (room_create_ip): 70 parallel creates, 70 e-mails, ONE (trusted-proxy supplied) client IP => exactly ipLim pass
  const ipLim = parseInt(__ENV.RL_CREATE_IP_LIMIT || '60', 10);
  const rsC = par(70, () => post('/api/room_create.php', { name: 'RL', email: randomEmail('rl.ip'), title: `k6-rl-${t}` }, simIp(903, 1)));
  if (count(rsC, 200) !== ipLim || count(rsC, 429) !== 70 - ipLim) fail(`C atomic ip limit: 200=${count(rsC, 200)} 429=${count(rsC, 429)} expected ${ipLim}/${70 - ipLim}`);

  // D. spoofing: instance whose TRUSTED_PROXIES excludes the generator => rotating X-Forwarded-For must not evade
  const spoof = __ENV.SPOOF_BASE_URL;
  if (spoof) {
    const rsD = http.batch(Array.from({ length: 70 }, (_, i) => ({ method: 'POST', url: `${spoof}/api/room_create.php`,
      body: JSON.stringify({ name: 'RL', email: randomEmail('rl.spoof'), title: `k6-rl-${t}` }),
      params: { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i + 1}`, 'X-Real-IP': `198.51.100.${i + 1}` }, responseCallback: http.expectedStatuses(200, 429) } })));
    if (count(rsD, 200) !== ipLim || count(rsD, 429) !== 70 - ipLim) fail(`D spoof evaded limit: 200=${count(rsD, 200)} 429=${count(rsD, 429)}`);
  } else { console.warn('SPOOF_BASE_URL not set: spoofing test NOT TESTED'); }

  // H. admin login: exactly 8 parallel wrong guesses reach bcrypt, the rest 429
  const adm = Array.from({ length: 12 }, () => ({ method: 'POST', url: `${BASE_URL}/api/admin_login.php`, body: JSON.stringify({ username: `nobody${t}`, password: 'wrong' }),
    params: { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': simIp(904, 1) }, responseCallback: http.expectedStatuses(401, 429) } }));
  const rsH = http.batch(adm);
  if (count(rsH, 401) !== 8 || count(rsH, 429) !== 4) fail(`H admin: 401=${count(rsH, 401)} 429=${count(rsH, 429)} expected 8/4`);

  // F. recovery after the window (rig uses short windows via RATE_LIMIT_OVERRIDES, never in prod)
  const wait = parseFloat(__ENV.RL_WINDOW_WAIT_S || '0');
  if (wait > 0) {
    sleep(wait);
    const rsF = par(1, () => post('/api/room_join.php', { name: 'RL', email, room_code: 'ZZZZZZZZ' }, simIp(901, 1)));
    if (rsF[0].status !== 404) fail(`F no recovery after window: ${rsF[0].status}`);
  } else { console.warn('RL_WINDOW_WAIT_S not set: window-recovery test NOT TESTED'); }
}

function buildScenarios() {
  if (preset) {
    return { [SCENARIO]: { executor: 'per-vu-iterations', vus: G_ROOMS, iterations: parseInt(__ENV.ITERATIONS || '1', 10), maxDuration: __ENV.MAX_DURATION || '40m', exec: 'fullGame' } };
  }
  if (SCENARIO === 'ratelimit') {
    return { ratelimit: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '5m', exec: 'rateLimit' } };
  }
  if (SCENARIO === 'all') {
    // Chain scenarios back to back in one run using startTime offsets, so
    // a single `k6 run -e SCENARIO=all` produces one combined report.
    // Durations below are conservative estimates used only to stagger
    // start times; each executor still stops on its own stage timing.
    return {
      smoke: { ...SCENARIOS.smoke, startTime: '0s' },
      load: { ...SCENARIOS.load, startTime: '2m30s' },
      stress: { ...SCENARIOS.stress, startTime: '7m30s' },
      soak: { ...SCENARIOS.soak, startTime: '13m' },
    };
  }
  if (!SCENARIOS[SCENARIO]) {
    throw new Error(`Unknown SCENARIO "${SCENARIO}". Use smoke | results | load | load30 | stress | soak | all | ratelimit | ${Object.keys(PRESETS).join(' | ')}.`);
  }
  return { [SCENARIO]: SCENARIOS[SCENARIO] };
}

const FULL = !!preset;
const P95 = Math.max(1, parseInt(__ENV.THRESH_P95_MS || '300', 10));
const P99 = Math.max(P95, parseInt(__ENV.THRESH_P99_MS || '500', 10));
const REPORT_DIR = (__ENV.REPORT_DIR || 'tests/load/results').replace(/\/+$/, '');
const gameThresholds = FULL ? {
  // Normal gameplay must never be throttled, and must be business-correct.
  housiy_http_429: ['count==0'],
  housiy_http_unexpected_4xx: ['count==0'],
  housiy_http_5xx: ['count==0'],
  housiy_transport_failures: ['count==0'],
  housiy_business_failures: ['count==0'],
  housiy_duplicate_winners: ['count==0'],
  housiy_reactions_failed: ['count==0'],
  housiy_reaction_send_ms: [`p(95)<${P95}`, `p(99)<${P99}`],
  http_req_failed: ['rate<0.005'],
  http_req_duration: [`p(95)<${P95}`, `p(99)<${P99}`],
  // Every measured gameplay endpoint gets a real tail-latency budget.
  housiy_room_create_ms: [`p(95)<${P95}`, `p(99)<${P99}`],
  housiy_room_join_ms: [`p(95)<${P95}`, `p(99)<${P99}`],
  housiy_game_start_ms: [`p(95)<${P95}`, `p(99)<${P99}`],
  housiy_game_next_ms: [`p(95)<${P95}`, `p(99)<${P99}`],
  housiy_mark_ms: [`p(95)<${P95}`, `p(99)<${P99}`],
  housiy_claim_ms: [`p(95)<${P95}`, `p(99)<${P99}`],
  housiy_results_ms: [`p(95)<${P95}`, `p(99)<${P99}`],
  housiy_ticket_ms: [`p(95)<${P95}`, `p(99)<${P99}`],
} : null;

export const options = {
  scenarios: buildScenarios(),
  thresholds: gameThresholds || (SCENARIO === 'ratelimit' ? { housiy_ratelimit_assertions_failed: ['count==0'] } : {
    // Overall SLOs.
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    housiy_full_flow_errors: ['count<1'],
    housiy_reactions_failed: ['count==0'],
    housiy_reaction_send_ms: ['p(95)<600'],
    ...(SCENARIO === 'results' ? {
      housiy_results_ms: [`p(95)<${parseInt(__ENV.RESULTS_P95_MS || '400', 10)}`],
      housiy_results_repeat_ms: [`p(95)<${parseInt(__ENV.RESULTS_P95_MS || '400', 10)}`],
    } : {}),

    // Per-endpoint SLOs - the write-heavy, lock-taking endpoints
    // (game_next.php takes a row lock; room_join.php checks capacity
    // under a lock) get a looser budget than simple reads.
    housiy_room_create_ms: ['p(95)<600'],
    housiy_room_join_ms: ['p(95)<600'],
    housiy_game_start_ms: ['p(95)<600'],
    housiy_game_next_ms: ['p(95)<700'],
    housiy_mark_ms: ['p(95)<500'],
    housiy_claim_ms: ['p(95)<500'],
    housiy_game_end_ms: ['p(95)<600'],
    housiy_results_ms: ['p(95)<400'],
  }),
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  assertSafeTarget(); // refuses prod / unlisted hosts / env mismatch before any traffic
  console.log(`Housiy k6 load test starting against ${BASE_URL} (scenario: ${SCENARIO})`);
  return { startedAt: new Date().toISOString(), baseUrl: BASE_URL, scenario: SCENARIO };
}

export default function () {
  playFullGame();
  sleep(1);
}

export function teardown(data) {
  console.log(`Housiy k6 load test finished (started ${data.startedAt}, scenario: ${data.scenario})`);
}

// --- Result generation -----------------------------------------------------
// Every run writes three artifacts into REPORT_DIR so results don't depend on scraping the terminal:
//   summary.json  - full machine-readable k6 summary (all metrics/thresholds)
//   summary.html  - a small, dependency-free HTML report for humans
//   junit.xml     - JUnit-style pass/fail per threshold, for Jenkins to
//                   publish alongside the PHPUnit/Playwright results
import { textSummary } from './lib/textSummary.js';
import { htmlReport } from './lib/htmlReport.js';
import { junitReport } from './lib/junitReport.js';

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`${REPORT_DIR}/summary.json`]: JSON.stringify(data, null, 2),
    [`${REPORT_DIR}/summary.html`]: htmlReport(data, SCENARIO, BASE_URL),
    [`${REPORT_DIR}/junit.xml`]: junitReport(data, SCENARIO),
  };
}
