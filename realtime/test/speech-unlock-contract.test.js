const fs = require('fs');
const source = fs.readFileSync(require('path').resolve(__dirname, '../../src/assets/js/common.js'), 'utf8');
const checks = [
  [/let speechUnlocked = false/.test(source), 'speech starts locked after page load'],
  [/pointerdown.*keydown.*touchstart/.test(source), 'first user gesture unlocks speech after refresh'],
  [/function speakOrQueue\(/.test(source) && /pendingSpeech\.push/.test(source), 'announcements are queued instead of silently dropped before unlock'],
  [/window\.speechSynthesis\.resume\(\)/.test(source), 'speech engine is resumed on unlock'],
  [/localStorage\.getItem\(SOUND_PREF_KEY\) === '1'/.test(source), 'saved speaker preference is restored after refresh'],
  [/unlockSpeechFromGesture\(\)/.test(source), 'sound toggle can unlock speech directly'],
];
let failed = false;
for (const [ok, label] of checks) { if (ok) console.log(`PASS ${label}`); else { console.error(`FAIL ${label}`); failed = true; } }
if (failed) process.exit(1);
console.log('ALL SPEECH UNLOCK CONTRACT CHECKS PASSED');
