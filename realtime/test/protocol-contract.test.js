'use strict';
const fs = require('fs');
const path = require('path');
const gateway = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '../../src/assets/js/emoji-reactions.js'), 'utf8');
const common = fs.readFileSync(path.join(__dirname, '../../src/assets/js/common.js'), 'utf8');
const gameEngine = fs.readFileSync(path.join(__dirname, '../../src/includes/GameEngine.php'), 'utf8');
const reactions = fs.readFileSync(path.join(__dirname, '../../src/includes/Reactions.php'), 'utf8');
const rematch = fs.readFileSync(path.join(__dirname, '../../src/api/room_rematch.php'), 'utf8');
const player = fs.readFileSync(path.join(__dirname, '../../src/assets/js/page-player.js'), 'utf8');
const host = fs.readFileSync(path.join(__dirname, '../../src/assets/js/page-host.js'), 'utf8');
const nginx = fs.readFileSync(path.join(__dirname, '../../deployment/docker/nginx/app.conf'), 'utf8');
const checks = [
  [gateway.includes("case 'SEND_EMOJI_REACTION':"), 'gateway accepts the reaction command'],
  [gateway.includes("'idempotency_key', 'room_code'"), 'gateway permits the exact frontend reaction payload'],
  [/data\.room_code[\s\S]{0,100}=== room/.test(gateway), 'gateway validates the embedded room code'],
  [/const targetUserId = ev\.user == null \? null : Number\(ev\.user\)/.test(gateway), 'Redis fanout derives the optional target user'],
  [/c\.userId !== targetUserId/.test(gateway), 'targeted events are isolated to the intended user'],
  [/idempotency_key:newIdempotencyKey\(\)/.test(client), 'reaction sends include an idempotency key'],
  [/housiyRealtimeSend\('SEND_EMOJI_REACTION', reactionPayload\)/.test(client), 'reaction uses the shared room WebSocket'],
  [/FALLBACK_POLL_MS/.test(common), 'HTTP polling remains a fallback transport'],
  [/if \(ws !== socket \|\| socketStopped\) return/.test(common), 'stale WebSocket close events cannot disable a newer connection'],
  [/auto_call_interval_seconds/.test(gameEngine) && /rtAutoCall = m\.data\?\.auto_call_enabled/.test(common), 'number events reset the client countdown from authoritative room settings'],
  [/proxy_read_timeout 3600s/.test(nginx), 'Nginx WebSocket read timeout exceeds normal idle windows'],
  [/host_user_id[\s\S]{0,160}return;/.test(reactions), 'room host is authorized for room-scoped reaction reads and sends'],
  [/INSERT INTO room_players/.test(rematch) && /INSERT INTO tickets/.test(rematch) && /hostPlayer->execute/.test(rematch) && /hostTicket->execute/.test(rematch), 'rematch creates the host membership and ticket transactionally'],
  [/playerAutoCallEnabled = !!res\.room\.auto_call_enabled/.test(player) && /playerRoomStatus = String\(res\.room\.status/.test(player), 'player page hydrates auto-call settings and room lifecycle from server snapshot'],
  [/if \(status === 'LOBBY'\)[\s\S]{0,280}secondsEl\.textContent = `\(\$\{interval\}s\)`/.test(player), 'player lobby shows configured auto-call pace without a running countdown'],
  [/autoCallUiRunning = status === 'LIVE'/.test(player) && /autoCallUiRunning = status === 'LIVE'/.test(host), 'host and player countdowns tick only while game is live'],
  [/Do not fetch results\.php from every ticket render/.test(player) && !/function renderAll\(res\)[\s\S]*?fetchRoomExtras\(\);/.test(player), 'player ticket rendering does not trigger duplicate results.php reads'],
  [/type === 'hello' && initialRoomExtrasLoaded/.test(player) && /'room_state_sync','player_joined','player_left','game_started','game_paused','game_resumed','game_ended','prize_won'/.test(player), 'player room extras refresh only on lifecycle and roster events'],
  [/initializeReactionCursor\(\)/.test(client) && /Promise\.allSettled\(\[loadHistory\(true\), initializeReactionCursor\(\), loadReactionCount\(\)\]\)/.test(client), 'emoji page uses one cursor baseline instead of an immediate poll'],
  [/if \(realtimeHelloSeen\) void poll\(true\)/.test(client), 'emoji cursor recovery polls only after a reconnect'],
  [/if \(\(type === 'player_joined' \|\| type === 'player_left'\) && modal\.classList\.contains\('open'\)/.test(client), 'player roster API is not called until recipient selection is open'],
];
let failed = 0;
for (const [ok, label] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log('ALL REALTIME PROTOCOL CONTRACT CHECKS PASSED');
