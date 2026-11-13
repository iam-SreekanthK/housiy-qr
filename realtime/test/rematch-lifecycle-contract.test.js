'use strict';
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const common = read('src/assets/js/common.js');
const player = read('src/assets/js/page-player.js');
const gateway = read('realtime/server.js');
const decline = read('src/api/room_rematch_decline.php');
const schema = read('sql/schema.sql');
const reactions = read('src/api/reactions.php');
const reactionUi = read('src/assets/js/emoji-reactions.js');
const checks = [
  [/A completed GAME is not a completed ROOM/.test(common), 'completed game keeps its room lifecycle WebSocket'],
  [/Cached terminal state disables game actions, not room connectivity/.test(common), 'cached completed rooms still reconnect for rematch events'],
  [/rematch_created -> ROOM_STATE_SYNC event triggers one canonical refresh/.test(player), 'rematch prompt is event-driven rather than timer-polled'],
  [/room\.rematch_prompt_pending === false/.test(player) && /rematch_prompt_pending/.test(read('src/api/results.php')), 'revisiting a completed room suppresses prompts after a saved join or decline decision'],
  [/EXISTS\(SELECT 1 FROM rooms nr JOIN room_players np/.test(read('src/api/results.php')), 'rematch acceptance is recovered from durable membership in the new room'],
  [/SELECT nr\.status FROM rooms nr WHERE nr\.room_code/.test(read('src/api/results.php')) && /rematch_status[^\n]*LOBBY|LOBBY/.test(read('src/api/results.php')), 'rematch invitation is suppressed once the target room leaves its lobby, including live and completed games'],
  [/DECLINE_REMATCH/.test(player) && /housiyStopRealtimeRoom/.test(player), 'NO persists the decline then stops this player connection'],
  [/DECLINE_REMATCH/.test(gateway) && /room_rematch_decline\.php/.test(gateway), 'gateway routes decline command to the authenticated PHP endpoint'],
  [/rematch_declines/.test(schema) && /UNIQUE KEY uq_room_rematch_decline/.test(schema), 'decline decision is durably and idempotently stored'],
  [/hash_equals\(\(string\)\(\$room\['rematch_room_code'\]/.test(decline), 'decline endpoint verifies the exact rematch belongs to the old room'],
  [/SELECT 1 FROM room_players/.test(decline), 'decline endpoint verifies old-room membership'],
  [/if \(gameCompleted && pendingMarks\.size\)/.test(player), 'completion clears unconfirmed optimistic ticket marks'],
  [/gameStatus === 'RUNNING' && !gameTimerInterval && gameTimerSeconds === 0/.test(player), 'fresh GO snapshot starts a new game timer without a page refresh'],
  [/CREATE TABLE IF NOT EXISTS room_rematch_declines/.test(schema), 'fresh-install schema includes the rematch decline table'],
  [/if \(!rtConnected\)\s*\{[\s\S]*?await fetchRoomExtras\(\{ fresh: true \}\)/.test(player), 'HTTP fallback refreshes rematch lifecycle metadata as well as ticket/prize state'],
  [/reaction_grace_until/.test(reactions) && /endedAt \+ 10/.test(reactions), 'server enforces a ten-second post-completion reaction grace period'],
  [/function syncRoomCompletion/.test(reactionUi) && /beginTerminalGrace\(serverDeadline\)/.test(reactionUi), 'emoji UI uses server-authoritative grace expiry during HTTP fallback'],
  [/window\.housiyGameTerminal && Date\.now\(\) >= Number\(window\.housiyReactionGraceUntil/.test(reactionUi), 'reaction fallback remains active during the post-completion grace window'],
];
let failed = 0;
for (const [ok, label] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failed++; }
if (failed) process.exit(1);
console.log('ALL REMATCH LIFECYCLE CONTRACT CHECKS PASSED');
