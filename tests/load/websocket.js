// Persistent WebSocket connection and heartbeat load test.
// Prepare existing DEV rooms first. ROOM_CODES is a comma-separated list of
// room codes with available seats. Each VU joins one room, authenticates via
// the real API, then holds one WebSocket connection for WS_DURATION.
import http from 'k6/http';
import ws from 'k6/ws';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { BASE_URL, assertSafeTarget, randomEmail, simIp, SIM_CLIENT_IPS } from './config.js';

const CONNECTIONS = Math.max(1, parseInt(__ENV.WS_CONNECTIONS || '100', 10));
const DURATION = __ENV.WS_DURATION || '5m';
const RAMP_MS = Math.max(0, parseInt(__ENV.WS_START_STAGGER_MS || '0', 10));
const ROOM_CODES = (__ENV.ROOM_CODES || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
const ROOM_CAPACITY = Math.max(1, parseInt(__ENV.WS_ROOM_CAPACITY || '99', 10));
const URL = BASE_URL.replace(/^http/, 'ws') + '/ws';
const REPORT_DIR = (__ENV.REPORT_DIR || 'tests/load/results/websocket').replace(/\/+$/, '');

const connected = new Counter('housiy_ws_connected');
const failed = new Counter('housiy_ws_failed');
const messages = new Counter('housiy_ws_messages_received');
const connectMs = new Trend('housiy_ws_connect_ms', true);
const connectSuccess = new Rate('housiy_ws_connect_success');
const snapshotRequests = new Counter('housiy_ws_snapshot_requests');
const snapshotFailures = new Counter('housiy_ws_snapshot_failures');
const eventDrivenSnapshots = new Counter('housiy_ws_event_driven_snapshots');
const sequenceGaps = new Counter('housiy_ws_sequence_gaps');
const snapshotMs = new Trend('housiy_ws_snapshot_ms', true);

export const options = {
  scenarios: {
    websocket_connections: {
      executor: 'per-vu-iterations',
      vus: CONNECTIONS,
      iterations: 1,
      maxDuration: `${parseDurationMs(DURATION) + RAMP_MS + 30000}ms`,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    housiy_ws_failed: ['count==0'],
    housiy_ws_connected: [`count==${CONNECTIONS}`],
    housiy_ws_connect_success: ['rate>0.99'],
    housiy_ws_connect_ms: ['p(95)<3000', 'p(99)<5000'],
    housiy_ws_snapshot_failures: ['count==0'],
    housiy_ws_event_driven_snapshots: ['count==0'],
    housiy_ws_snapshot_ms: ['p(95)<500', 'p(99)<1000'],
  },
};

export function setup() {
  assertSafeTarget();
  if (!ROOM_CODES.length) throw new Error('Set ROOM_CODES to comma-separated, pre-created DEV room codes.');
  const requiredRooms = Math.ceil(CONNECTIONS / ROOM_CAPACITY);
  if (ROOM_CODES.length < requiredRooms) {
    throw new Error(`Need at least ${requiredRooms} room codes for ${CONNECTIONS} VUs at ${ROOM_CAPACITY} seats/room; got ${ROOM_CODES.length}.`);
  }
  return { startedAt: new Date().toISOString() };
}

export default function () {
  if (RAMP_MS > 0) sleep((Math.random() * RAMP_MS) / 1000);
  const roomIndex = Math.floor((__VU - 1) / ROOM_CAPACITY);
  const roomCode = ROOM_CODES[roomIndex];
  const email = randomEmail(`ws.vu${__VU}`);
  const name = `WS Load ${__VU}`;
  const jar = http.cookieJar();
  const headers = { 'Content-Type': 'application/json' };
  if (SIM_CLIENT_IPS) headers['X-Forwarded-For'] = simIp(roomIndex, __VU);

  const joined = http.post(`${BASE_URL}/api/room_join.php`, JSON.stringify({ name, email, room_code: roomCode }), {
    jar,
    headers,
    tags: { name: 'ws_load_join' },
    responseCallback: http.expectedStatuses(200),
  });
  if (joined.status !== 200 || !joined.json('success')) {
    failed.add(1); connectSuccess.add(false);
    console.error(`WS_JOIN_FAILED vu=${__VU} status=${joined.status} room=${roomCode}`);
    sleep(1);
    return;
  }

  const cookieMap = jar.cookiesForURL(BASE_URL);
  const cookieParts = [];
  for (const [key, values] of Object.entries(cookieMap || {})) {
    for (const value of values || []) cookieParts.push(`${key}=${value}`);
  }
  if (!cookieParts.length) {
    failed.add(1); connectSuccess.add(false);
    console.error(`WS_COOKIE_MISSING vu=${__VU}`);
    return;
  }

  const connectStarted = Date.now();
  const wsUrl = `${URL}?room=${encodeURIComponent(roomCode)}`;
  const fetchSnapshot = (reason) => {
    if (reason !== 'hello' && reason !== 'gap') { eventDrivenSnapshots.add(1); failed.add(1); return; }
    const snapshot = http.get(`${BASE_URL}/api/ticket.php?room_code=${encodeURIComponent(roomCode)}`, {
      jar, headers, tags: { name: `ws_snapshot_${reason}` },
      responseCallback: http.expectedStatuses(200),
    });
    snapshotRequests.add(1);
    snapshotMs.add(snapshot.timings.duration);
    if (snapshot.status !== 200 || !snapshot.json('game')) {
      snapshotFailures.add(1); failed.add(1);
      console.error(`WS_SNAPSHOT_FAILED vu=${__VU} reason=${reason} status=${snapshot.status}`);
    }
  };
  const response = ws.connect(wsUrl, {
    headers: { Cookie: cookieParts.join('; '), Origin: BASE_URL },
    tags: { name: 'websocket_connect' },
  }, (socket) => {
    socket.on('open', () => {
      connected.add(1);
      connectSuccess.add(true);
      connectMs.add(Date.now() - connectStarted);
    });
    socket.on('message', (raw) => {
      messages.add(1);
      let message;
      try { message = JSON.parse(raw); } catch (_) { failed.add(1); return; }
      if (message.t === 'hello' || message.event === 'HELLO') {
        // Exactly one authoritative snapshot after handshake/reconnect.
        // Ordinary pushed events are consumed over this socket; never poll per event.
        const helloSequence = Number(message.sequence || 0);
        socket.__lastSequence = Math.max(socket.__lastSequence || 0, helloSequence);
        fetchSnapshot('hello');
      } else {
        const isReaction = message.event === 'EMOJI_REACTION' || message.e === 'reaction';
        const sequence = Number(message.sequence || message.v || 0);
        if (!isReaction && sequence > 0) {
          const last = socket.__lastSequence || 0;
          if (last > 0 && sequence > last + 1) {
            sequenceGaps.add(1);
            fetchSnapshot('gap');
          }
          if (sequence > last) socket.__lastSequence = sequence;
        }
        // Reactions and ordinary room events are delivered inline over WebSocket.
        // A snapshot is requested only when a sequence gap indicates missed state.
      }
    });
    socket.on('error', () => { failed.add(1); connectSuccess.add(false); });
    socket.setTimeout(() => socket.close(), parseDurationMs(DURATION));
  });
  if (!response || response.status !== 101) {
    failed.add(1); connectSuccess.add(false);
    console.error(`WS_HANDSHAKE_FAILED vu=${__VU} status=${response && response.status}`);
  }
}

function parseDurationMs(value) {
  const m = String(value).match(/^(\d+)(ms|s|m|h)$/);
  if (!m) return 300000;
  const n = Number(m[1]);
  return n * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]);
}


// Keep WebSocket test artifacts separate from HTTP game-flow reports.
import { textSummary } from './lib/textSummary.js';
import { htmlReport } from './lib/htmlReport.js';
import { junitReport } from './lib/junitReport.js';
export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`${REPORT_DIR}/summary.json`]: JSON.stringify(data, null, 2),
    [`${REPORT_DIR}/summary.html`]: htmlReport(data, 'websocket_connections', BASE_URL),
    [`${REPORT_DIR}/junit.xml`]: junitReport(data, 'websocket_connections'),
  };
}
