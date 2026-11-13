// Shared configuration for the Housiy k6 load test suite.
// Every value can be overridden with `-e KEY=value` on the k6 command line.
//
// SAFETY MODEL (see assertSafeTarget): the suite only ever runs against a
// target explicitly designated as "dev" or "uat". Production is refused,
// the target host must be on an allow-list, and the environment the SERVER
// reports (GET /api/env.php) must equal TARGET_ENV. A typo in BASE_URL can
// therefore never point a load test at the live site.
import http from 'k6/http';

export const TARGET_ENV = (__ENV.TARGET_ENV || 'dev').toLowerCase();
export const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:80').replace(/\/$/, '');

// Unique id for this run; embedded in room titles so the DB verifier can find exactly this run's rooms.
export const RUN_ID = __ENV.RUN_ID || `r${Date.now().toString(36)}`;

// Players per room INCLUDING the host (the app caps a room at 100 incl. host).
export const PLAYERS_PER_ROOM = parseInt(__ENV.PLAYERS_PER_ROOM || '5', 10);
export const ROOMS = parseInt(__ENV.ROOMS || '5', 10);
// Spread room creation / player joining over this many seconds (realistic staggering).
export const RAMP_SECONDS = parseFloat(__ENV.RAMP_SECONDS || '10');
// Pace of the host's "call next" presses. Policy game_next allows 120/min; stay under it.
export const CALL_INTERVAL_MS = parseInt(__ENV.CALL_INTERVAL_MS || '700', 10);
export const MAX_CALLS = parseInt(__ENV.MAX_CALLS || '90', 10);

export const NUMBERS_TO_CALL = parseInt(__ENV.NUMBERS_TO_CALL || '10', 10);
// Matches GameEngine::START_COUNTDOWN_SECONDS in src/includes/GameEngine.php.
export const START_COUNTDOWN_SECONDS = parseInt(__ENV.START_COUNTDOWN_SECONDS || '5', 10);

// Give every simulated actor its own client address via X-Forwarded-For.
// This is only honoured by the app when the load generator's TCP address is
// in the target's TRUSTED_PROXIES (configured for UAT/DEV test rigs). It
// models real, distinct players; it does not bypass anything - the
// rate-limit security scenario separately proves spoofed headers from an
// untrusted peer are ignored. Set SIM_CLIENT_IPS=false to send everything
// from the generator's own address.
export const SIM_CLIENT_IPS = (__ENV.SIM_CLIENT_IPS || 'true') !== 'false';

export function randomEmail(prefix) {
  return `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1e9)}@loadtest.example.com`;
}

export function simIp(roomIdx, actorIdx) {
  const r = roomIdx % 62500;
  return `10.${Math.floor(r / 250)}.${r % 250}.${(actorIdx % 250) + 1}`;
}

function hostOf(url) {
  const m = url.match(/^https?:\/\/([^/:]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Refuse to run unless the target is an explicitly designated dev/uat
 * environment. Call from setup(). Throws (aborting the k6 run) otherwise.
 */
export function assertSafeTarget() {
  if (TARGET_ENV === 'prod' || TARGET_ENV === 'production') {
    throw new Error('SAFETY: TARGET_ENV=prod is refused. Load/security/stress tests never run against production.');
  }
  if (TARGET_ENV !== 'dev' && TARGET_ENV !== 'uat') {
    throw new Error(`SAFETY: TARGET_ENV must be "dev" or "uat" (got "${TARGET_ENV}").`);
  }
  const allowed = (__ENV.LOAD_ALLOWED_HOSTS || '127.0.0.1,localhost,host.docker.internal')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = hostOf(BASE_URL);
  if (!allowed.includes(host)) {
    throw new Error(`SAFETY: host "${host}" is not in LOAD_ALLOWED_HOSTS (${allowed.join(',')}). Add it explicitly if this is your UAT host.`);
  }
  const res = http.get(`${BASE_URL}/api/env.php`, { tags: { name: 'env_probe' } });
  let reported = null;
  try { reported = res.json('env'); } catch (e) { /* handled below */ }
  if (res.status !== 200 || !reported) {
    throw new Error(`SAFETY: could not verify the target environment via /api/env.php (HTTP ${res.status}). Refusing to run.`);
  }
  if (reported === 'prod') {
    throw new Error('SAFETY: the target reports environment "prod". Refusing to run.');
  }
  if (reported !== TARGET_ENV) {
    throw new Error(`SAFETY: target reports env "${reported}" but TARGET_ENV="${TARGET_ENV}". Refusing to run.`);
  }
  return reported;
}
