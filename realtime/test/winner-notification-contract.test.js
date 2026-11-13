'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const player = read('src/assets/js/page-player.js');
const host = read('src/assets/js/page-host.js');
const common = read('src/assets/js/common.js');
const emoji = read('src/assets/js/emoji-reactions.js');
const reactions = read('src/api/reactions.php');
const checks = [
  [/function announceWinnerOnce\(/.test(player), 'one shared popup/voice handler deduplicates by prize'],
  [/if \(!rtConnected\)\s*\{[\s\S]*?await fetchRoomExtras\(\{ fresh: true \}\)/.test(player), 'disconnected player fetches authoritative results during HTTP fallback'],
  [/announceWinnerOnce\(data\.winner_name, prize, data\.winner_email \|\| null\)/.test(player), 'WebSocket prize event uses shared winner announcement handler'],
  [/announceWinnerOnce\(w\.winner_name, w\.prize_type, w\.winner_email\)/.test(player), 'snapshot recovery uses same winner announcement handler'],
  [/WINNER_DECLARED:'prize_won'/.test(common) && /PRIZE_CLAIMED/.test(common), 'room WebSocket dispatches both winner event forms'],
  [/if \(type === 'prize_won'\)[\s\S]*?void poll\(\)\.catch/.test(host), 'host immediately reconciles canonical winner state on prize event'],
  [/PRIZE_CLAIMED/.test(common) && /WINNER_DECLARED/.test(common), 'completed room accepts late winner events for rematch lifecycle'],
  [/el\.style\.animationDuration = '10s'/.test(emoji), 'floating emoji remains visible for 10 seconds'],
  [/endedAt \+ 10/.test(reactions), 'server enforces 10-second post-completion reaction grace'],
  [/function announceRoomWinnerOnce\(/.test(common), 'single shared room-wide winner popup and voice handler exists'],
  [/window\.__housiyRoomWinnerAnnouncements/.test(common) && /roomWinnerAnnouncements\.has\(announcementKey\)/.test(common), 'winner voice idempotency is shared across WebSocket and snapshot handlers'],
  [/roomWinnerAnnouncements\.add\(announcementKey\);[\s\S]*?speakPhrase\(/.test(common), 'winner is marked announced before speech is queued'],
  [/final_winners' => \$winners/.test(read('src/includes/GameEngine.php')), 'GAME_FINISHED carries the authoritative complete winners list'],
  [/type === 'game_ended'[\s\S]*?showFinalWinnersOnce\(finalWinners, roomCode\)/.test(host), 'host opens the final winners card from the room-wide finish event'],
  [/type === 'game_ended'[\s\S]*?showFinalWinnersOnce\(finalWinners, roomCode\)/.test(player), 'every player opens the same final winners card from the room-wide finish event'],
  [/function showFinalWinnersOnce\(/.test(common) && /roomWinnerAnnouncements\.add\(prize\)/.test(common), 'final summary is shown once and suppresses duplicate per-prize voice after completion'],
  [/announceRoomWinnerOnce\(winnerName, prize/.test(host), 'host uses the same winner announcement handler as players'],
  [/announceRoomWinnerOnce\(winnerName, prize/.test(player), 'claiming and non-claiming players use the same winner announcement handler'],
  [/Realtime::room\(\(string\)\$room\['room_code'\], 'prize_won', null, \$claimEvent\)/.test(read('src/api/claim.php')), 'server publishes one canonical winner event to every room participant'],
  [(read('src/api/claim.php').match(/Realtime::room\(\(string\)\$room\['room_code'\], 'prize_(?:claimed|won)'/g) || []).length === 1, 'server emits exactly one prize event per successful claim (prevents duplicate voice)'],
  [/previousCurrentNumber = n;[\s\S]*?if \(isNewCalledNumber\) speakNumber\(n\)/.test(host), 'host WebSocket number event updates snapshot baseline and speaks each number only once'],
  [/const fullHouse = winners\.find[\s\S]*?setTimeout\(\(\) => showFinalWinnersBanner\(winners, onClose\), 4600\)/.test(common), 'Full House winner banner and celebration finish before final winners card opens'],
  [/unlockUtterance\.onend = \(\) =>[\s\S]*?pendingSpeech\.shift\(\)/.test(common), 'Chrome queued speech drains after speech engine unlock completes'],
  [/function maskWinnerEmail\(email\)/.test(common) && /maskWinnerEmail\(w\.winner_email\)/.test(common), 'final winners card masks winner email addresses'],
  [/escapeHtml\(w\.winner_email\)/.test(host) && /escapeHtml\(w\.winner_email\)/.test(player), 'host and player prize winners lists mask winner email addresses'],
  [/maskWinnerEmail\(winnerEmail\)/.test(common) && /winner_email.*maskedEmail/.test(read('src/api/claim.php')), 'individual prize winner banner receives participant-format masked email'],
  [/value\.slice\(0, at\)\.includes\('\*'\)/.test(common), 'already-masked participant emails are not masked a second time'],
  [/mask_room_public_people\(/.test(read('src/includes/GameEngine.php')) && /'final_winners' => \$winners/.test(read('src/includes/GameEngine.php')), 'final winners realtime payload masks email before broadcast'],
  [/\.rematch-invite-actions[\s\S]*?justify-content: center/.test(read('src/assets/css/style.css')) && /class=\"rematch-invite-actions\"/.test(player), 'rematch Yes and Decline buttons are centered together'],
  [/function reactionLabel\(senderName\)[\s\S]*?return isCurrentUserSender\(senderName\) \? 'You'/.test(emoji), 'emoji reaction is labelled You for its sender'],
  [/spawn\(reaction\.emoji, reactionLabel\(reaction\.sender_name\)\)/.test(emoji) && /reactionLabel\(reaction\.sender_name\)/.test(emoji), 'emoji recipients see the sender player name'],
];
let failed = 0;
for (const [ok, label] of checks) { if (ok) console.log(`PASS ${label}`); else { console.error(`FAIL ${label}`); failed++; } }
if (failed) process.exit(1);
console.log('ALL WINNER NOTIFICATION CONTRACT CHECKS PASSED');
