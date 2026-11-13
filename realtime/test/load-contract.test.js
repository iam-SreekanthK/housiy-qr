'use strict';
// Guard the k6 WebSocket workload against accidentally reintroducing HTTP polling
// for every pushed event. This is a source-contract test; live delivery is covered
// by tests/e2e/realtime-race.js and tests/load/websocket.js.
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../../tests/load/websocket.js'), 'utf8');
const checks = [
  [source.includes("fetchSnapshot('hello')"), 'one canonical snapshot is requested on HELLO'],
  [source.includes("fetchSnapshot('gap')"), 'a snapshot is requested when a sequence gap is detected'],
  [/sequence\s*>\s*last\s*\+\s*1/.test(source), 'sequence-gap detection compares against the last observed sequence'],
  [/message\.event\s*===\s*'EMOJI_REACTION'/.test(source), 'reaction events are identified as inline WebSocket events'],
  [/reason\s*!==\s*'hello'\s*&&\s*reason\s*!==\s*'gap'/.test(source), 'the load script rejects event-triggered snapshots'],
  [!/fetchSnapshot\(['"]event['"]\)/.test(source), 'ordinary room events do not trigger HTTP snapshots'],
  [source.includes("housiy_ws_event_driven_snapshots: ['count==0']"), 'k6 threshold fails if an ordinary event triggers an HTTP snapshot'],
];
let failures = 0;
for (const [pass, label] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) failures++;
}
if (failures) process.exit(1);
console.log('ALL LOAD CONTRACT CHECKS PASSED');
