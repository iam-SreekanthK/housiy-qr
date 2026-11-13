// Shared "one full game" iteration used by every scenario (smoke, load,
// stress, soak). Each iteration simulates a real room end-to-end:
//   host creates room -> N players join -> host starts game
//   -> host calls numbers (players poll + mark + attempt claims in between)
//   -> host ends game -> host + a player fetch results
//
// Every actor (host and each player) gets its own cookie jar via
// http.cookieJar(), mirroring separate browser sessions, since the app's
// Auth::identify() ties identity to the PHP session cookie.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL,
  PLAYERS_PER_ROOM,
  NUMBERS_TO_CALL,
  START_COUNTDOWN_SECONDS,
  SIM_CLIENT_IPS,
  simIp,
  randomEmail,
} from '../config.js';

// Per-endpoint latency trends.
export const roomCreateTrend = new Trend('housiy_room_create_ms', true);
export const roomJoinTrend = new Trend('housiy_room_join_ms', true);
export const gameStartTrend = new Trend('housiy_game_start_ms', true);
export const gameNextTrend = new Trend('housiy_game_next_ms', true);
export const markTrend = new Trend('housiy_mark_ms', true);
export const playerPollTrend = new Trend('housiy_player_poll_ms', true);
export const playerPollFailures = new Counter('housiy_player_poll_failures');
export const claimTrend = new Trend('housiy_claim_ms', true);
export const gameEndTrend = new Trend('housiy_game_end_ms', true);
export const resultsTrend = new Trend('housiy_results_ms', true);
export const resultsRepeatTrend = new Trend('housiy_results_repeat_ms', true);
export const reactionTrend = new Trend('housiy_reaction_send_ms', true);
export const reactionsSent = new Counter('housiy_reactions_sent');
export const reactionsEveryoneSent = new Counter('housiy_reactions_everyone_sent');
export const reactionsPlayerSent = new Counter('housiy_reactions_player_sent');
export const reactionFailures = new Counter('housiy_reactions_failed');

// Bound total reaction POST attempts per room.
// The default of 100 is split between both reaction audiences.
const MAX_REACTIONS_PER_ROOM = Math.max(
  0,
  parseInt(__ENV.MAX_REACTIONS_PER_ROOM || '100', 10)
);

const REACTIONS_PER_TARGET = Math.ceil(MAX_REACTIONS_PER_ROOM / 2);

const REACTION_EVERY_N_CALLS = Math.max(
  4,
  parseInt(__ENV.REACTION_EVERY_N_CALLS || '10', 10)
);

// Periodic concurrent state reads approximate active clients.
// These are HTTP polls, not persistent WebSocket connections.
const PLAYER_POLL_EVERY_N_CALLS = Math.max(
  0,
  parseInt(__ENV.PLAYER_POLL_EVERY_N_CALLS || '5', 10)
);

const REACTION_EMOJIS = [
  '🎉', '❤️', '😂', '👏', '🔥', '👍',
  '😍', '😮', '🥳', '🙌', '💯', '😢',
];

export const roomsCreated = new Counter('housiy_rooms_created');
export const fullFlowErrors = new Counter('housiy_full_flow_errors');

// Simulated client address per actor (cookie jar).
// X-Forwarded-For is only trusted when the generator is a configured
// trusted proxy in the target environment.
const ipOf = new Map();

function ipHeaders(jar) {
  const ip = ipOf.get(jar);

  return SIM_CLIENT_IPS && ip
    ? { 'X-Forwarded-For': ip }
    : {};
}

// Log response bodies and headers to help identify whether a failure
// originates in the application, reverse proxy, CDN, or another layer.
function logHttpFailure(label, res, details = '') {
  console.error(
    `${label}${details ? ` ${details}` : ''} ` +
    `status=${res.status} ` +
    `body=${String(res.body || '').slice(0, 500)} ` +
    `headers=${JSON.stringify(res.headers || {})}`
  );
}

function post(jar, path, body, extraParams) {
  return http.post(
    `${BASE_URL}${path}`,
    JSON.stringify(body),
    {
      headers: {
        'Content-Type': 'application/json',
        ...ipHeaders(jar),
      },
      jar,
      ...extraParams,
    }
  );
}

function get(jar, path) {
  return http.get(`${BASE_URL}${path}`, {
    jar,
    headers: ipHeaders(jar),
  });
}

function safeJson(res, path) {
  try {
    return res.json(path);
  } catch (_) {
    return undefined;
  }
}

// Sends a room-wide or directed reaction from simulated actors.
// Player IDs are resolved from the application's players API.
function sendReactionWave(
  actors,
  roomCode,
  target,
  recipientPool,
  budget
) {
  // No requests needed is not a failure.
  if (!actors.length) return true;

  const requests = [];
  const metadata = [];

  const targetRemaining = Math.max(
    0,
    REACTIONS_PER_TARGET - budget.byTarget[target]
  );

  const roomRemaining = Math.max(
    0,
    MAX_REACTIONS_PER_ROOM - budget.attempted
  );

  const allowance = Math.min(targetRemaining, roomRemaining);

  if (allowance <= 0) return true;

  // Send at most one reaction per actor per target for this room.
  const eligibleActors = actors
    .filter(
      (actor) =>
        actor.userId &&
        !budget.sentUserIds[target].has(String(actor.userId))
    )
    .slice(0, Math.min(allowance, 1));

  for (const actor of eligibleActors) {
    if (!actor.userId) {
      reactionFailures.add(1);

      console.error(
        `REACTION_ACTOR_ID_MISSING name=${actor.name}`
      );

      continue;
    }

    let recipientId = null;

    if (target === 'player') {
      const choices = recipientPool.filter(
        (player) =>
          player.userId &&
          player.userId !== actor.userId
      );

      if (!choices.length) {
        reactionFailures.add(1);

        console.error(
          `REACTION_RECIPIENT_MISSING sender=${actor.name}`
        );

        continue;
      }

      recipientId =
        choices[Math.floor(Math.random() * choices.length)].userId;
    }

    const body = {
      room_code: roomCode,
      emoji:
        REACTION_EMOJIS[
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
        headers: {
          'Content-Type': 'application/json',
          ...ipHeaders(actor.jar),
        },
        tags: {
          name:
            target === 'everyone'
              ? 'reaction_everyone'
              : 'reaction_player',
        },
        responseCallback: http.expectedStatuses(200, 429),
      },
    });

    budget.sentUserIds[target].add(String(actor.userId));
    metadata.push({ actor, target });
  }

  if (!requests.length) return true;

  // Pace reaction POSTs to avoid artificial request bursts.
  sleep(0.25 + Math.random() * 0.5);

  // Count attempts, not successes, to enforce the room-wide cap.
  budget.attempted += requests.length;
  budget.byTarget[target] += requests.length;

  const responses = http.batch(requests);
  let waveOk = true;

  responses.forEach((res, index) => {
    reactionTrend.add(res.timings.duration);

    if (
      res.status === 200 &&
      safeJson(res, 'success') === true
    ) {
      reactionsSent.add(1);

      if (metadata[index].target === 'everyone') {
        reactionsEveryoneSent.add(1);
      } else {
        reactionsPlayerSent.add(1);
      }
    } else {
      reactionFailures.add(1);
      waveOk = false;

      // FIX: do not assign to the playFullGame() local variable
      // from inside this function. Return the result to the caller.
      logHttpFailure(
        'REACTION_SEND_FAILED',
        res,
        `target=${metadata[index].target}`
      );
    }
  });

  return waveOk;
}

/** One full game lifecycle. Returns true if every step behaved correctly. */
export function playFullGame() {
  let ok = true;

  const hostJar = new http.CookieJar();
  const roomIdx = __VU * 1000 + __ITER;

  ipOf.set(hostJar, simIp(roomIdx, 0));

  let roomCode = null;
  let hostUserId = null;

  group('01_room_create', function () {
    const res = post(hostJar, '/api/room_create.php', {
      name: `Load Host ${__VU}`,
      email: randomEmail(`host.vu${__VU}`),
      title: `k6 Load Test Room VU${__VU} Iter${__ITER}`,
      max_players: Math.max(10, PLAYERS_PER_ROOM),
    });

    roomCreateTrend.add(res.timings.duration);

    if (res.status !== 200 || !res.body) {
      logHttpFailure(
        'ROOM_CREATE_FAILED',
        res,
        `VU=${__VU} ITER=${__ITER}`
      );
    }

    const passed = check(res, {
      'room_create: status 200': (r) => r.status === 200,
      'room_create: success true': (r) =>
        r.json('success') === true,
      'room_create: room in LOBBY': (r) =>
        r.json('room.status') === 'LOBBY',
    });

    ok = ok && passed;

    if (passed) {
      roomCode = res.json('room.room_code');
      hostUserId = safeJson(res, 'user.id');
      roomsCreated.add(1);
    }
  });

  if (!roomCode) {
    fullFlowErrors.add(1);
    return false;
  }

  const playerActors = [];

  group('02_players_join', function () {
    for (let i = 0; i < PLAYERS_PER_ROOM - 1; i++) {
      const jar = new http.CookieJar();

      ipOf.set(jar, simIp(roomIdx, i + 1));

      const res = post(jar, '/api/room_join.php', {
        name: `Load Player ${__VU}.${i}`,
        email: randomEmail(`player.vu${__VU}.${i}`),
        room_code: roomCode,
      });

      roomJoinTrend.add(res.timings.duration);

      const passed = check(res, {
        'room_join: status 200': (r) => r.status === 200,
        'room_join: success true': (r) =>
          r.json('success') === true,
        'room_join: ticket has 15 numbers': (r) => {
          const grid = r.json('ticket.grid');

          if (!grid) return false;

          let count = 0;

          for (const row of grid) {
            for (const value of row) {
              if (value !== 0) count++;
            }
          }

          return count === 15;
        },
      });

      ok = ok && passed;

      if (passed) {
        playerActors.push({
          jar,
          name: `Load Player ${__VU}.${i}`,
          userId: safeJson(res, 'user.id'),
        });
      }
    }
  });

  // Resolve actor IDs using the room-scoped players API.
  const hostActor = {
    jar: hostJar,
    name: `Load Host ${__VU}`,
    userId: hostUserId,
  };

  const actors = [hostActor, ...playerActors];

  const playerListRes = get(
    hostJar,
    `/api/reactions.php?action=players&room_code=${encodeURIComponent(roomCode)}`
  );

  const playerList = safeJson(playerListRes, 'players') || [];
  const idByName = {};

  playerList.forEach((player) => {
    if (player && player.name && player.id) {
      idByName[player.name] = Number(player.id);
    }
  });

  actors.forEach((actor) => {
    if (!actor.userId && idByName[actor.name]) {
      actor.userId = idByName[actor.name];
    }
  });

  const recipientPool = actors.filter((actor) => actor.userId);

  group('03_game_start', function () {
    const res = post(
      hostJar,
      '/api/game_start.php',
      { room_code: roomCode }
    );

    gameStartTrend.add(res.timings.duration);

    const passed = check(res, {
      'game_start: status 200': (r) => r.status === 200,
      'game_start: game LIVE': (r) =>
        r.json('room_status') === 'LIVE',
    });

    ok = ok && passed;
  });

  // Honor the application's deliberate start countdown.
  sleep(START_COUNTDOWN_SECONDS + 0.5);

  let numbersCalled = 0;
  let sentEveryoneReactionWave = false;
  let sentPlayerReactionWave = false;

  const reactionBudget = {
    attempted: 0,
    byTarget: {
      everyone: 0,
      player: 0,
    },
    sentUserIds: {
      everyone: new Set(),
      player: new Set(),
    },
  };

  group('04_call_and_mark_numbers', function () {
    for (let i = 0; i < NUMBERS_TO_CALL; i++) {
      const nextRes = post(
        hostJar,
        '/api/game_next.php',
        { room_code: roomCode }
      );

      gameNextTrend.add(nextRes.timings.duration);

      const nextOk = check(nextRes, {
        'game_next: status 200': (r) => r.status === 200,
        'game_next: success true': (r) =>
          r.json('success') === true,
      });

      // Capture response body and headers for upstream/app 429 or 5xx.
      if (
        !nextOk &&
        (
          nextRes.status === 429 ||
          nextRes.status >= 500 ||
          nextRes.status === 0
        )
      ) {
        logHttpFailure(
          'GAME_NEXT_FAILED',
          nextRes,
          `VU=${__VU} ITER=${__ITER} room=${roomCode}`
        );
      }

      ok = ok && nextOk;

      if (!nextOk) break;

      numbersCalled++;

      const calledNumber = nextRes.json('number');

      // Spread reactions through the live game.
      const waveOffset = i % REACTION_EVERY_N_CALLS;

      if (waveOffset === 0) {
        if (sentEveryoneReactionWave || sentPlayerReactionWave) {
          sleep(0.9);
        }

        ok =
          sendReactionWave(
            actors,
            roomCode,
            'everyone',
            recipientPool,
            reactionBudget
          ) && ok;

        sentEveryoneReactionWave = true;
      } else if (
        waveOffset === Math.floor(REACTION_EVERY_N_CALLS / 2)
      ) {
        if (sentEveryoneReactionWave || sentPlayerReactionWave) {
          sleep(0.9);
        }

        ok =
          sendReactionWave(
            actors,
            roomCode,
            'player',
            recipientPool,
            reactionBudget
          ) && ok;

        sentPlayerReactionWave = true;
      }

      // Mark requests overlap through a batch.
      // HTTP 400 is expected when the number isn't on the player's ticket.
      const markRequests = [];
      const markPlayers = [];

      for (const player of playerActors) {
        if (Math.random() < 0.6) {
          markRequests.push({
            method: 'POST',
            url: `${BASE_URL}/api/mark.php`,
            body: JSON.stringify({
              room_code: roomCode,
              number: calledNumber,
            }),
            params: {
              jar: player.jar,
              headers: {
                'Content-Type': 'application/json',
                ...ipHeaders(player.jar),
              },
              tags: { name: 'mark' },
              responseCallback: http.expectedStatuses(200, 400),
            },
          });

          markPlayers.push(player);
        }
      }

      if (markRequests.length) {
        const markResponses = http.batch(markRequests);

        markResponses.forEach((markRes, index) => {
          markTrend.add(markRes.timings.duration);

          const statusExpected =
            markRes.status === 200 ||
            markRes.status === 400;

          const jsonOk =
            statusExpected &&
            (
              markRes.status === 400 ||
              safeJson(markRes, 'success') === true
            );

          if (!jsonOk) {
            ok = false;

            logHttpFailure(
              'MARK_FAILED',
              markRes,
              `player=${markPlayers[index].name}`
            );
          }
        });
      }

      // Simulate concurrent live-state refreshes every N calls.
      if (
        PLAYER_POLL_EVERY_N_CALLS > 0 &&
        (i + 1) % PLAYER_POLL_EVERY_N_CALLS === 0 &&
        playerActors.length
      ) {
        const pollUrl =
          `${BASE_URL}/api/ticket.php?room_code=${encodeURIComponent(roomCode)}`;

        const pollRequests = playerActors.map((player) => ({
          method: 'GET',
          url: pollUrl,
          params: {
            jar: player.jar,
            headers: ipHeaders(player.jar),
            tags: { name: 'ticket_live_poll' },
            responseCallback: http.expectedStatuses(200),
          },
        }));

        const pollResponses = http.batch(pollRequests);

        pollResponses.forEach((pollRes, index) => {
          playerPollTrend.add(pollRes.timings.duration);

          if (
            pollRes.status !== 200 ||
            !safeJson(pollRes, 'game')
          ) {
            playerPollFailures.add(1);
            ok = false;

            logHttpFailure(
              'PLAYER_POLL_FAILED',
              pollRes,
              `player=${playerActors[index].name}`
            );
          }
        });
      }

      sleep(0.1);
    }
  });

  // Short games may finish before the scheduled reaction waves.
  if (numbersCalled > 0 && !sentEveryoneReactionWave) {
    ok =
      sendReactionWave(
        actors,
        roomCode,
        'everyone',
        recipientPool,
        reactionBudget
      ) && ok;

    sentEveryoneReactionWave = true;
  }

  if (numbersCalled > 0 && !sentPlayerReactionWave) {
    sleep(0.9);

    ok =
      sendReactionWave(
        actors,
        roomCode,
        'player',
        recipientPool,
        reactionBudget
      ) && ok;

    sentPlayerReactionWave = true;
  }

  group('05_claim_attempts', function () {
    if (playerActors.length === 0) return;

    // Expected rejection: FULL_HOUSE cannot be complete after only
    // NUMBERS_TO_CALL draws. Exercises the claim ledger validation path.
    const jar = playerActors[0].jar;

    const res = post(
      jar,
      '/api/claim.php',
      {
        room_code: roomCode,
        prize_type: 'FULL_HOUSE',
      }
    );

    claimTrend.add(res.timings.duration);

    const passed = check(res, {
      'claim: status 200': (r) => r.status === 200,
      'claim: correctly rejected as invalid': (r) =>
        r.json('valid') === false,
    });

    ok = ok && passed;

    if (!passed) {
      logHttpFailure('CLAIM_FAILED', res, `room=${roomCode}`);
    }
  });

  group('06_game_end', function () {
    const res = post(
      hostJar,
      '/api/game_end.php',
      { room_code: roomCode }
    );

    gameEndTrend.add(res.timings.duration);

    const passed = check(res, {
      'game_end: status 200': (r) => r.status === 200,
      'game_end: success true': (r) =>
        r.json('success') === true,
    });

    ok = ok && passed;

    if (!passed) {
      logHttpFailure('GAME_END_FAILED', res, `room=${roomCode}`);
    }
  });

  group('07_results', function () {
    // Use the room code returned by the successful room creation.
    const path =
      `/api/results.php?room_code=${encodeURIComponent(roomCode)}`;

    const res = get(hostJar, path);

    resultsTrend.add(res.timings.duration);

    const passed = check(res, {
      'results: status 200': (r) => r.status === 200,
      'results: room COMPLETED': (r) =>
        r.json('room.status') === 'COMPLETED',
      'results: game ENDED': (r) =>
        r.json('game.status') === 'ENDED',
    });

    ok = ok && passed;

    if (!passed) {
      logHttpFailure('RESULTS_FAILED', res, `room=${roomCode}`);
    }

    // Dedicated Results benchmark.
    if (__ENV.SCENARIO === 'results' && passed) {
      const repeatCount = Math.max(
        1,
        Math.min(
          500,
          parseInt(__ENV.RESULTS_REPEAT_COUNT || '20', 10)
        )
      );

      for (let i = 0; i < repeatCount; i++) {
        const repeatRes = get(hostJar, path);

        resultsRepeatTrend.add(repeatRes.timings.duration);

        const repeatOk = check(repeatRes, {
          'results_repeat: status 200': (r) =>
            r.status === 200,
          'results_repeat: room COMPLETED': (r) =>
            r.json('room.status') === 'COMPLETED',
          'results_repeat: game ENDED': (r) =>
            r.json('game.status') === 'ENDED',
        });

        if (!repeatOk) {
          ok = false;

          logHttpFailure(
            'RESULTS_REPEAT_FAILED',
            repeatRes,
            `room=${roomCode} iteration=${i}`
          );
        }
      }

      console.log(
        `RESULTS_BENCHMARK ${JSON.stringify({
          vu: __VU,
          iteration: __ITER,
          roomCode,
          repeatCount,
          initialMs: res.timings.duration,
        })}`
      );
    }
  });

  if (!ok) {
    fullFlowErrors.add(1);
  }

  return ok;
}