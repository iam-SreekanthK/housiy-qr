// Reusable building blocks for FULL Housiy games over HTTP (k6).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL, RUN_ID, SIM_CLIENT_IPS, CALL_INTERVAL_MS, MAX_CALLS, RAMP_SECONDS,
  START_COUNTDOWN_SECONDS, randomEmail, simIp,
} from '../config.js';

export const m = {
  throttled: new Counter('housiy_http_429'),
  unexpected4xx: new Counter('housiy_http_unexpected_4xx'),
  server5xx: new Counter('housiy_http_5xx'),
  transport: new Counter('housiy_transport_failures'),
  business: new Counter('housiy_business_failures'),
  roomsCreated: new Counter('housiy_rooms_created'),
  playersJoined: new Counter('housiy_players_joined'),
  participants: new Counter('housiy_players_participating'),
  gamesStarted: new Counter('housiy_games_started'),
  gamesCompleted: new Counter('housiy_games_completed'),
  journeys: new Counter('housiy_player_journeys_completed'),
  numbersCalled: new Counter('housiy_numbers_called'),
  marks: new Counter('housiy_marks_ok'),
  claimsValid: new Counter('housiy_claims_valid'),
  claimsRejected: new Counter('housiy_claims_rejected_expected'),
  negativeProbesOk: new Counter('housiy_negative_probes_ok'),
  duplicateWinners: new Counter('housiy_duplicate_winners'),
  reactionsSent: new Counter('housiy_reactions_sent'),
  reactionsEveryoneSent: new Counter('housiy_reactions_everyone_sent'),
  reactionsPlayerSent: new Counter('housiy_reactions_player_sent'),
  reactionFailures: new Counter('housiy_reactions_failed'),
  reaction: new Trend('housiy_reaction_send_ms', true),
  gameSeconds: new Trend('housiy_game_duration_s', false),
  create: new Trend('housiy_room_create_ms', true),
  join: new Trend('housiy_room_join_ms', true),
  start: new Trend('housiy_game_start_ms', true),
  next: new Trend('housiy_game_next_ms', true),
  mark: new Trend('housiy_mark_ms', true),
  claim: new Trend('housiy_claim_ms', true),
  end: new Trend('housiy_game_end_ms', true),
  results: new Trend('housiy_results_ms', true),
  ticket: new Trend('housiy_ticket_ms', true),
};

export const PRIZES = [
  'FIRST_FIVE', 'TOP_ROW', 'MIDDLE_ROW', 'BOTTOM_ROW', 'FULL_HOUSE',
];

export function createClient(label, roomIdx, actorIdx) {
  return {
    label,
    jar: new http.CookieJar(),
    ip: simIp(roomIdx, actorIdx),
    email: randomEmail(label.replace(/[^a-z0-9.]/gi, '')),
    name: `LT ${label}`,
    grid: null,
    marks: new Set(),
    nums: [],
    userId: null,
  };
}

function hdrs(c, extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  if (SIM_CLIENT_IPS && c && c.ip) h['X-Forwarded-For'] = c.ip;
  return h;
}

export function track(res, okStatuses) {
  const ok = okStatuses || [200];

  if (res.status === 0) {
    m.transport.add(1);
    return false;
  }

  if (res.status === 429) {
    m.throttled.add(1);
    return false;
  }

  if (res.status >= 500) {
    m.server5xx.add(1);
    return false;
  }

  if (res.status >= 400 && ok.indexOf(res.status) === -1) {
    m.unexpected4xx.add(1);
    return false;
  }

  return ok.indexOf(res.status) !== -1;
}

/**
 * Diagnostic logging for HTTP 429, 5xx and transport failures.
 * Never logs cookies or authorization credentials.
 */
function logHttpFailure(endpoint, res, actor = '') {
  if (res.status !== 429 && res.status < 500 && res.status !== 0) return;

  console.error(JSON.stringify({
    diagnostic: 'HTTP_FAILURE',
    endpoint,
    actor,
    status: res.status,
    url: res.url,
    body: String(res.body || '').slice(0, 500),
    headers: {
      server: res.headers?.Server,
      retryAfter: res.headers?.['Retry-After'],
      cfRay: res.headers?.['Cf-Ray'],
      contentType: res.headers?.['Content-Type'],
    },
  }));
}

export function api(c, method, path, body, opts) {
  const o = opts || {};
  const params = {
    jar: c.jar,
    headers: hdrs(c, o.headers),
    tags: { name: o.name || path.split('?')[0] },
    responseCallback: http.expectedStatuses(...(o.expect || [200])),
  };

  if (o.noJar) delete params.jar;

  const url = `${BASE_URL}${path}`;

  return method === 'GET'
    ? http.get(url, params)
    : http.post(url, JSON.stringify(body || {}), params);
}

function jget(res, path) {
  try {
    return res.json(path);
  } catch (e) {
    return undefined;
  }
}

export function createRoom(host, title, maxPlayers) {
  const res = api(
    host,
    'POST',
    '/api/room_create.php',
    {
      name: host.name,
      email: host.email,
      title,
      max_players: maxPlayers,
    },
    { name: 'room_create' },
  );

  m.create.add(res.timings.duration);

  const ok =
    track(res) &&
    jget(res, 'success') === true &&
    jget(res, 'room.status') === 'LOBBY';

  if (ok) {
    m.roomsCreated.add(1);
    host.userId = jget(res, 'user.id') || null;
  }

  return ok ? jget(res, 'room.room_code') : null;
}

function countTicket(grid) {
  let n = 0;
  for (const row of grid) {
    for (const value of row) {
      if (value !== 0) n++;
    }
  }
  return n;
}

export function joinRoom(c, roomCode) {
  const res = api(
    c,
    'POST',
    '/api/room_join.php',
    { name: c.name, email: c.email, room_code: roomCode },
    { name: 'room_join' },
  );

  m.join.add(res.timings.duration);

  if (!track(res) || jget(res, 'success') !== true) return false;

  const grid = jget(res, 'ticket.grid');

  if (!grid || countTicket(grid) !== 15) {
    m.business.add(1);
    return false;
  }

  c.grid = grid;
  c.nums = [].concat(...grid).filter((v) => v !== 0);
  c.userId = jget(res, 'user.id') || null;

  m.playersJoined.add(1);
  return true;
}

export function startGame(host, roomCode) {
  const res = api(
    host,
    'POST',
    '/api/game_start.php',
    { room_code: roomCode },
    { name: 'game_start' },
  );

  m.start.add(res.timings.duration);

  const ok = track(res) && jget(res, 'room_status') === 'LIVE';
  if (ok) m.gamesStarted.add(1);

  return ok;
}

export function callNext(host, roomCode) {
  const res = api(
    host,
    'POST',
    '/api/game_next.php',
    { room_code: roomCode },
    { name: 'game_next' },
  );

  m.next.add(res.timings.duration);

  if (!track(res) || jget(res, 'success') !== true) return null;

  m.numbersCalled.add(1);
  return jget(res, 'number');
}

export function fetchResults(c, roomCode) {
  const res = api(
    c,
    'GET',
    `/api/results.php?room_code=${roomCode}`,
    null,
    { name: 'results' },
  );

  m.results.add(res.timings.duration);
  return track(res) ? res.json() : null;
}

export function fetchTicket(c, roomCode) {
  const res = api(
    c,
    'GET',
    `/api/ticket.php?room_code=${roomCode}`,
    null,
    { name: 'ticket' },
  );

  m.ticket.add(res.timings.duration);
  return track(res) ? res.json() : null;
}

function batchReq(c, path, body, name) {
  return {
    method: 'POST',
    url: `${BASE_URL}${path}`,
    body: JSON.stringify(body),
    params: {
      jar: c.jar,
      headers: hdrs(c),
      tags: { name },
      responseCallback: http.expectedStatuses(200, 400),
    },
  };
}

// ---- emoji reactions ----------------------------------------------------
const MAX_REACTIONS_PER_ROOM = Math.max(
  0,
  parseInt(__ENV.MAX_REACTIONS_PER_ROOM || '100', 10),
);
const REACTIONS_PER_TARGET = Math.ceil(MAX_REACTIONS_PER_ROOM / 2);
const REACTION_EVERY_N_CALLS = Math.max(
  4,
  parseInt(__ENV.REACTION_EVERY_N_CALLS || '10', 10),
);
const PLAYER_POLL_EVERY_N_CALLS = Math.max(
  0,
  parseInt(__ENV.PLAYER_POLL_EVERY_N_CALLS || '5', 10),
);
const REACTION_EMOJIS = [
  '🎉', '❤️', '😂', '👏', '🔥', '👍',
  '😍', '😮', '🥳', '🙌', '💯', '😢',
];

function sendReactionWave(actors, roomCode, target, budget) {
  const requests = [];
  const meta = [];

  const targetRemaining = Math.max(
    0,
    REACTIONS_PER_TARGET - budget.byTarget[target],
  );
  const roomRemaining = Math.max(0, MAX_REACTIONS_PER_ROOM - budget.attempted);
  const allowance = Math.min(targetRemaining, roomRemaining);

  if (allowance <= 0) return;

  const eligibleActors = actors
    .filter(
      (actor) =>
        actor.userId &&
        !budget.sentUserIds[target].has(String(actor.userId)),
    )
    .slice(0, Math.min(allowance, 1));

  for (const actor of eligibleActors) {
    if (!actor.userId) {
      m.reactionFailures.add(1);
      m.business.add(1);
      console.error(`REACTION_ACTOR_ID_MISSING name=${actor.name}`);
      continue;
    }

    let recipientId = null;

    if (target === 'player') {
      const candidates = actors.filter(
        (p) => p.userId && p.userId !== actor.userId,
      );

      if (!candidates.length) {
        m.reactionFailures.add(1);
        m.business.add(1);
        console.error(`REACTION_RECIPIENT_MISSING sender=${actor.name}`);
        continue;
      }

      recipientId =
        candidates[Math.floor(Math.random() * candidates.length)].userId;
    }

    const body = {
      room_code: roomCode,
      emoji: REACTION_EMOJIS[
        Math.floor(Math.random() * REACTION_EMOJIS.length)
      ],
      target,
      recipient_id: recipientId,
    };

    requests.push({
      method: 'POST',
      url: `${BASE_URL}/api/reactions.php`,
      body: JSON.stringify(body),
      params: {
        jar: actor.jar,
        headers: hdrs(actor),
        tags: {
          name: target === 'everyone'
            ? 'reaction_everyone'
            : 'reaction_player',
        },
        responseCallback: http.expectedStatuses(200, 429),
      },
    });

    budget.sentUserIds[target].add(String(actor.userId));
    meta.push(target);
  }

  if (!requests.length) return;

  sleep(0.25 + Math.random() * 0.5);

  budget.attempted += requests.length;
  budget.byTarget[target] += requests.length;

  const rs = http.batch(requests);

  rs.forEach((res, i) => {
    m.reaction.add(res.timings.duration);

    if (res.status === 200 && jget(res, 'success') === true) {
      m.reactionsSent.add(1);

      if (meta[i] === 'everyone') {
        m.reactionsEveryoneSent.add(1);
      } else {
        m.reactionsPlayerSent.add(1);
      }
    } else {
      m.reactionFailures.add(1);
      logHttpFailure('reaction', res, meta[i]);

      console.error(
        `REACTION_SEND_FAILED target=${meta[i]} status=${res.status} body=${String(res.body || '').slice(0, 250)}`,
      );

      if (res.status === 429) m.throttled.add(1);
      else if (res.status >= 500) m.server5xx.add(1);
      else if (res.status >= 400) m.unexpected4xx.add(1);
      else if (res.status === 0) m.transport.add(1);
    }
  });
}// ---- game rules ---------------------------------------------------------
function rowNumbers(grid, i) {
  return grid[i].filter((v) => v !== 0);
}

export function eligible(c, prize, called, won) {
  const marked = c.marks;
  const all = (nums) =>
    nums.length > 0 && nums.every((n) => called.has(n) && marked.has(n));

  switch (prize) {
    case 'TOP_ROW':
      return all(rowNumbers(c.grid, 0));

    case 'MIDDLE_ROW':
      return all(rowNumbers(c.grid, 1));

    case 'BOTTOM_ROW':
      return all(rowNumbers(c.grid, 2));

    case 'FIRST_FIVE': {
      const calledOnTicket = c.nums.filter((n) => called.has(n));
      return (
        calledOnTicket.length >= 5 &&
        calledOnTicket.filter((n) => marked.has(n)).length >= 5
      );
    }

    case 'FULL_HOUSE':
      return PRIZES.slice(0, 4).every((p) => won[p]) && all(c.nums);

    default:
      return false;
  }
}

// ---- one complete multiplayer game -------------------------------------
export function playRoom(roomIdx, players, opts) {
  const o = Object.assign(
    { joinGapMs: 40, markProb: 0.92, invalidClaimProb: 0.2, raceMax: 4 },
    opts || {},
  );

  const t0 = Date.now();
  const rid = `${RUN_ID}-${roomIdx}`;
  const host = createClient(`host.${rid}`, roomIdx, 0);

  const sum = {
    runId: RUN_ID,
    roomIdx,
    ok: true,
    roomCode: null,
    players: 0,
    joinedPlayers: 0,
    calls: 0,
    winners: {},
    duplicateWinners: 0,
    validClaims: 0,
    rejectedClaims: 0,
    errors: [],
  };

  const fail = (msg) => {
    sum.ok = false;
    sum.errors.push(msg);
    m.business.add(1);
  };

  if (RAMP_SECONDS > 0) {
    sleep(Math.random() * RAMP_SECONDS);
  }

  const roomCode = createRoom(
    host,
    `k6-${rid}`,
    Math.max(2, Math.min(100, players)),
  );

  if (!roomCode) {
    fail('room_create');
    return sum;
  }

  sum.roomCode = roomCode;

  const ht = fetchTicket(host, roomCode);

  if (ht && ht.ticket && ht.ticket.grid) {
    host.grid = ht.ticket.grid;
    host.nums = [].concat(...host.grid).filter((v) => v !== 0);
  }

  const all = [host];

  for (let i = 1; i < players; i++) {
    const p = createClient(`p.${rid}.${i}`, roomIdx, i);

    if (!joinRoom(p, roomCode)) {
      fail(`join_${i}`);
      continue;
    }

    all.push(p);
    sleep(Math.random() * 2 * o.joinGapMs / 1000);
  }

  const playable = all.filter((p) => p.grid);

  const playerListRes = api(
    host,
    'GET',
    `/api/reactions.php?action=players&room_code=${encodeURIComponent(roomCode)}`,
    null,
    { name: 'reaction_players' },
  );

  const listedPlayers = track(playerListRes)
    ? (jget(playerListRes, 'players') || [])
    : [];

  const idByName = {};

  listedPlayers.forEach((p) => {
    if (p && p.name && p.id) idByName[p.name] = Number(p.id);
  });

  playable.forEach((p) => {
    if (!p.userId && idByName[p.name]) {
      p.userId = idByName[p.name];
    }
  });

  sum.players = playable.length;
  sum.joinedPlayers = all.filter((p) => p !== host).length;
  m.participants.add(playable.length);

  // ---- negative probes: validation and authorization -------------------
  const outsider = createClient(`out.${rid}`, roomIdx, 251);

  const rOut = api(
    outsider,
    'POST',
    '/api/room_join.php',
    {
      name: outsider.name,
      email: outsider.email,
      room_code: 'ZZZZZZZZ',
    },
    { expect: [404], name: 'probe_join_unknown' },
  );

  let probesOk = track(rOut, [404]);

  const rNoAuth = api(
    outsider,
    'POST',
    '/api/claim.php',
    { room_code: roomCode, prize_type: 'TOP_ROW' },
    { expect: [401], noJar: true, name: 'probe_claim_unauth' },
  );

  probesOk = track(rNoAuth, [401]) && probesOk;

  const bad = api(
    playable[0] || host,
    'POST',
    '/api/claim.php',
    { room_code: roomCode, prize_type: 'NOT_A_PRIZE' },
    { expect: [400], name: 'probe_claim_malformed' },
  );

  probesOk = track(bad, [400]) && probesOk;

  const badMark = api(
    playable[0] || host,
    'POST',
    '/api/mark.php',
    { room_code: roomCode, number: 0 },
    { expect: [400], name: 'probe_mark_invalid' },
  );

  probesOk = track(badMark, [400]) && probesOk;

  if (probesOk) m.negativeProbesOk.add(1);
  else fail('negative_probes');

  if (!startGame(host, roomCode)) {
    fail('game_start');
    return sum;
  }

  sleep(START_COUNTDOWN_SECONDS + 0.7);

  const called = new Set();
  const won = {};
  let ended = false;
  let sentEveryoneReactionWave = false;
  let sentPlayerReactionWave = false;

  const reactionBudget = {
    attempted: 0,
    byTarget: { everyone: 0, player: 0 },
    sentUserIds: { everyone: new Set(), player: new Set() },
  };

  for (let k = 1; k <= MAX_CALLS && !ended; k++) {
    const n = callNext(host, roomCode);

    if (n === null || n === undefined) {
      fail(`call_${k}`);
      break;
    }

    called.add(n);
    sum.calls = k;

    // Send room-wide and directed reactions periodically.
    const waveOffset = (k - 1) % REACTION_EVERY_N_CALLS;

    if (waveOffset === 0) {
      sendReactionWave(playable, roomCode, 'everyone', reactionBudget);
      sentEveryoneReactionWave = true;
    } else if (
      waveOffset === Math.floor(REACTION_EVERY_N_CALLS / 2)
    ) {
      sendReactionWave(playable, roomCode, 'player', reactionBudget);
      sentPlayerReactionWave = true;
    }

    // Mark called numbers concurrently for players holding them.
    const holders = playable.filter(
      (p) => p.nums.indexOf(n) !== -1 && Math.random() < o.markProb,
    );

    if (holders.length) {
      const rs = http.batch(
        holders.map((p) =>
          batchReq(
            p,
            '/api/mark.php',
            { room_code: roomCode, number: n },
            'mark',
          ),
        ),
      );

      rs.forEach((r, i) => {
        m.mark.add(r.timings.duration);
        logHttpFailure('mark', r, holders[i].label);

        if (track(r) && jget(r, 'success') === true) {
          holders[i].marks.add(n);
          m.marks.add(1);
        } else {
          fail(`mark_${holders[i].label}_${n}_${r.status}`);
        }
      });
    }

    // Catch up on previously called numbers that a player did not mark.
    if (k % 6 === 0 || k >= 60) {
      const lag = [];

      playable.forEach((p) => {
        p.nums.forEach((x) => {
          if (called.has(x) && !p.marks.has(x)) {
            lag.push([p, x]);
          }
        });
      });

      for (let i = 0; i < lag.length; i += 40) {
        const chunk = lag.slice(i, i + 40);

        const rs = http.batch(
          chunk.map(([p, x]) =>
            batchReq(
              p,
              '/api/mark.php',
              { room_code: roomCode, number: x },
              'mark',
            ),
          ),
        );

        rs.forEach((r, j) => {
          m.mark.add(r.timings.duration);
          logHttpFailure('mark_catchup', r, chunk[j][0].label);

          if (track(r) && jget(r, 'success') === true) {
            chunk[j][0].marks.add(chunk[j][1]);
            m.marks.add(1);
          } else {
            fail(`catchup_${r.status}`);
          }
        });
      }
    }

    // Eligible players race to claim each prize.
    for (const prize of PRIZES) {
      if (won[prize]) continue;

      const elig = playable.filter((p) =>
        eligible(p, prize, called, won),
      );

      if (!elig.length) continue;

      const racers = elig.slice(0, o.raceMax);

      const rs = http.batch(
        racers.map((p) =>
          batchReq(
            p,
            '/api/claim.php',
            { room_code: roomCode, prize_type: prize },
            'claim',
          ),
        ),
      );

      let valid = 0;

      rs.forEach((r, i) => {
        m.claim.add(r.timings.duration);

        logHttpFailure('claim', r, racers[i].label);

        if (!track(r, [200])) {
          fail(`claim_${prize}_${r.status}`);
          return;
        }

        if (jget(r, 'valid') === true) {
          valid++;
          won[prize] = racers[i].email;
          m.claimsValid.add(1);
          sum.validClaims++;
        } else {
          m.claimsRejected.add(1);
          sum.rejectedClaims++;
        }
      });

      if (valid === 0) {
        fail(`no_valid_claim_${prize}_with_${racers.length}_eligible`);
      }

      if (valid > 1) {
        sum.duplicateWinners += valid - 1;
        m.duplicateWinners.add(valid - 1);
        fail(`duplicate_winner_${prize}`);
      }
    }

    // An ineligible player attempts to claim an open prize.
    if (Math.random() < o.invalidClaimProb) {
      const open = PRIZES.filter((p) => !won[p]);
      const pr = open.length
        ? open[Math.floor(Math.random() * open.length)]
        : 'FULL_HOUSE';

      const cand = playable.filter(
        (p) => !eligible(p, pr, called, won),
      );

      if (cand.length) {
        const p = cand[Math.floor(Math.random() * cand.length)];

        const r = api(
          p,
          'POST',
          '/api/claim.php',
          { room_code: roomCode, prize_type: pr },
          { name: 'claim_invalid' },
        );

        m.claim.add(r.timings.duration);
        logHttpFailure('claim_invalid', r, p.label);

        if (track(r) && jget(r, 'valid') === false) {
          m.claimsRejected.add(1);
          sum.rejectedClaims++;
        } else {
          fail(`invalid_claim_not_rejected_${pr}`);
        }
      }
    }
    // Simulate active players refreshing their ticket/game state.
    if (
      PLAYER_POLL_EVERY_N_CALLS > 0 &&
      k % PLAYER_POLL_EVERY_N_CALLS === 0 &&
      playable.length > 0
    ) {
      const url =
        `${BASE_URL}/api/ticket.php?room_code=${encodeURIComponent(roomCode)}`;

      const pollRequests = playable.map((p) => ({
        method: 'GET',
        url,
        params: {
          jar: p.jar,
          headers: hdrs(p),
          tags: { name: 'ticket_live_poll' },
          responseCallback: http.expectedStatuses(200),
        },
      }));

      const pollResponses = http.batch(pollRequests);

      pollResponses.forEach((r, i) => {
        m.ticket.add(r.timings.duration);

        logHttpFailure(
          'ticket_live_poll',
          r,
          playable[i].label,
        );

        if (!track(r) || !jget(r, 'game')) {
          fail(
            `ticket_live_poll_${playable[i].label}_${r.status}`,
          );
        }
      });
    }

    if (PRIZES.every((p) => won[p])) {
      ended = true;
    } else {
      sleep(CALL_INTERVAL_MS / 1000);
    }
  }

  // Ensure both reaction audiences are covered while the game is live.
  if (sum.calls > 0 && !sentEveryoneReactionWave) {
    sendReactionWave(
      playable,
      roomCode,
      'everyone',
      reactionBudget,
    );
    sentEveryoneReactionWave = true;
  }

  if (sum.calls > 0 && !sentPlayerReactionWave) {
    sleep(0.9);

    sendReactionWave(
      playable,
      roomCode,
      'player',
      reactionBudget,
    );
    sentPlayerReactionWave = true;
  }

  // ---- final state validation -------------------------------------------
  sleep(0.3);

  const hostView = fetchResults(host, roomCode);

  if (!hostView) {
    fail('results_host');
    return sum;
  }

  if (
    hostView.room.status !== 'COMPLETED' ||
    hostView.game.status !== 'ENDED'
  ) {
    fail(
      `not_completed_${hostView.room.status}/${hostView.game.status}`,
    );
  }

  // Compare stable test identities, not masked email addresses.
  const norm = (v) =>
    (v.winners || [])
      .map(
        (w) =>
          `${w.prize_type}:${w.winner_name ?? w.name ?? w.player_name ?? ''}`,
      )
      .sort()
      .join('|');

  const expected = PRIZES.map((p) => {
    const winner = playable.find(
      (player) => player.email === won[p],
    );

    return `${p}:${winner?.name ?? ''}`;
  })
    .sort()
    .join('|');

  if (norm(hostView) !== expected) {
    fail('host_view_winners_mismatch');
  }

  const seen = {};

  (hostView.winners || []).forEach((w) => {
    seen[w.prize_type] = (seen[w.prize_type] || 0) + 1;
  });

  PRIZES.forEach((p) => {
    if (seen[p] !== 1) {
      fail(`prize_${p}_winner_count_${seen[p] || 0}`);
    }
  });

  const sample = playable
    .filter((p) => p !== host)
    .slice(0, 3);

  sample.forEach((p) => {
    const v = fetchResults(p, roomCode);

    if (!v || norm(v) !== norm(hostView)) {
      fail('player_view_differs_from_host');
    }
  });

  if (hostView.game.numbers_called_count !== sum.calls) {
    fail(
      `calls_mismatch_${hostView.game.numbers_called_count}_vs_${sum.calls}`,
    );
  }

  sum.winners = won;

  if (sum.ok) {
    m.gamesCompleted.add(1);
    m.journeys.add(playable.length);
  }

  m.gameSeconds.add((Date.now() - t0) / 1000);

  console.log(
    `ROOM_RESULT ${JSON.stringify({
      runId: RUN_ID,
      roomIdx,
      roomCode,
      ok: sum.ok,
      players: sum.players,
      joinedPlayers: sum.joinedPlayers,
      calls: sum.calls,
      winners: won,
      duplicateWinners: sum.duplicateWinners,
      errors: sum.errors.slice(0, 5),
    })}`,
  );

  return sum;
}