'use strict';
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const schema = read('sql/schema.sql'), fh = read('src/includes/FullHouse.php'), claim = read('src/api/claim.php');
const engine = read('src/includes/GameEngine.php'), create = read('src/api/room_create.php');
const index = read('src/index.html'), pageIndex = read('src/assets/js/page-index.js');
const common = read('src/assets/js/common.js'), player = read('src/assets/js/page-player.js'), host = read('src/assets/js/page-host.js');
const checks = [
  [/full_house_winners TINYINT UNSIGNED NOT NULL DEFAULT 1/.test(schema), 'rooms stores how many Full House winners are allowed (default 1)'],
  [/UNIQUE KEY uq_room_prize_pos \(room_id, prize_type, winner_position\)/.test(schema), 'winners table allows several Full House rows via winner_position'],
  [!/ensureSchema|ALTER TABLE/.test(fh + create + claim) && !fs.existsSync(path.join(root, 'sql/upgrade-full-house-winners.sql')), 'no migration code: fresh schema only'],
  [/MAX_WINNERS = 5/.test(fh) && /function slots\(/.test(fh), 'FullHouse helper: max 5, slots capped by players'],
  [/id="fullHouseWinnersInput"[^>]*min="1"[^>]*max="5"/.test(index) && /id="fullHouseCheck"/.test(index), 'number input (1-5) sits next to the Full House checkbox'],
  [/full_house_winners: fullHouseWinners/.test(pageIndex) && /fullHouseWinnersInput\.disabled = !fullHouseCheck\.checked/.test(pageIndex), 'create-room sends the value and the box follows the checkbox'],
  [/FullHouse::normalize\(\$body\['full_house_winners'\]/.test(create), 'server clamps the requested winner count'],
  [/\$userAlreadyWon/.test(claim) && /You have already won Full House/.test(claim), 'a player can take only one Full House slot'],
  [/winner_position/.test(claim) && /full_house_remaining/.test(claim), 'claim stores the position and announces slots remaining'],
  [/FullHouse::slots\(\$freshRoom/.test(engine) && /Full House still has winners to come/.test(engine), 'game continues until every Full House slot is filled'],
  [/function prizeClaimLabel\(/.test(common) && /\$\{baseLabel\} \(\$\{remaining\}\)/.test(common), 'claim button shows the remaining count in brackets'],
  [/function applyClaimButtonState\(/.test(common) && /prize === 'FULL_HOUSE' && mine/.test(common), "winner's own Full House button turns green and closes while others stay open"],
  [/function winnerKey\(/.test(common) && /winner_position/.test(player) && /winner_position/.test(host), 'each Full House winner is announced once (banner + voice) on host and players'],
  [/winnerListPrizeLabel\(/.test(player) && /winnerListPrizeLabel\(/.test(host), 'winners lists number the Full House winners'],
  [/FullHouse::annotate/.test(read('src/api/admin_room_details.php')) && /FullHouse::annotate/.test(read('src/api/admin_export_pdf.php')) && /FullHouse::annotate/.test(read('src/api/admin_export_excel.php')), 'admin details, PDF and Excel reports list every Full House winner'],
  [/full_house_winners/.test(read('src/api/room_rematch.php')), 'rematch keeps the same Full House winner count'],
];
let failed = 0;
for (const [ok, label] of checks) { if (ok) console.log('PASS ' + label); else { console.error('FAIL ' + label); failed++; } }
if (failed) process.exit(1);
console.log('ALL FULL HOUSE WINNERS CONTRACT CHECKS PASSED');
