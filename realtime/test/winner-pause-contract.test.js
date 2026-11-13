'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const engine = read('src/includes/GameEngine.php');
const common = read('src/assets/js/common.js');
const css = read('src/assets/css/style.css');
const checks = [
  [/WINNER_ANNOUNCE_HOLD_SECONDS = \d+/.test(engine), 'server defines a winner-announcement hold window'],
  [/function winnerHoldRemainingSeconds\(/.test(engine) && /MAX\(awarded_at\)/.test(engine), 'hold is measured from the latest prize award'],
  [/function autoCallIfDue[\s\S]*?winnerHoldRemainingSeconds\(\$pdo[\s\S]*?\$calledStmt/.test(engine), 'auto-call is skipped while a winner announcement is playing'],
  [/function callNext[\s\S]*?winnerHoldRemainingSeconds\(\$pdo[\s\S]*?\$calledStmt/.test(engine), 'manual Call Next is also blocked during the hold'],
  [/function autoCallSecondsRemaining\([^)]*array \$winners = \[\]\)/.test(engine), 'countdown display accounts for the hold'],
  [/auto_call_seconds_remaining|autoCallSecondsRemaining\(\$room, \$game, \$state\['last_called_at'\] \?\? null, \$state\['winners'\] \?\? \[\]\)/.test(read('src/api/results.php')), 'results.php passes winners to the countdown'],
  [/autoCallSecondsRemaining\(\$room, \$game, \$state\['last_called_at'\] \?\? null, \$state\['winners'\] \?\? \[\]\)/.test(read('src/api/ticket.php')), 'ticket.php passes winners to the countdown'],
  [/winnerAnnounceQueue\.push\(/.test(common) && /function runNextWinnerAnnouncement\(/.test(common), 'winner alerts play sequentially through a queue'],
  [/minElapsed && voiceDone/.test(common), 'banner stays until minimum time AND voice have both finished'],
  [/function dismissWinnerBanner\(/.test(common) && /winner-banner-out/.test(css), 'banner slides out instead of vanishing'],
  [/function speakPhrase\(text, onDone\)/.test(common) && /if \(!spoken\) done\(\)/.test(common), 'speakPhrase reports completion (and never blocks when speech is locked)'],
  [/priorityUtteranceCount === 0/.test(common) && !/priorityUtteranceActive/.test(common), 'number calls never cancel while any winner phrase is queued or speaking'],
  [!/function speakPhrase[\s\S]{0,900}speechSynthesis\.cancel\(\)/.test(common), 'winner phrase never cancels the number being spoken'],
];
let failed = 0;
for (const [ok, label] of checks) { if (ok) console.log(`PASS ${label}`); else { console.error(`FAIL ${label}`); failed++; } }
if (failed) process.exit(1);
console.log('ALL WINNER PAUSE CONTRACT CHECKS PASSED');
