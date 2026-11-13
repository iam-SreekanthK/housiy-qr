'use strict';
// Numbers that landed while a page was behind (HTTP fallback / reconnect snapshot)
// must each be spoken, in call order, instead of only the newest one.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const src = fs.readFileSync(path.join(root, 'src/assets/js/common.js'), 'utf8');
const player = fs.readFileSync(path.join(root, 'src/assets/js/page-player.js'), 'utf8');
const host = fs.readFileSync(path.join(root, 'src/assets/js/page-host.js'), 'utf8');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const spoken = []; let cancels = 0;
class Utter { constructor(t) { this.text = t; this.rate = 1; } }
const el = { textContent: '' };
const ctx = {
  console: { log() {}, warn() {}, error() {} }, Math, JSON, Date, Promise,
  location: { protocol: 'https:', host: 'h.example', href: '' },
  WebSocket: class {},
  document: { hidden: false, addEventListener() {}, getElementById: () => el, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }), body: { appendChild() {} }, documentElement: { style: {} } },
  localStorage: { getItem: k => (k === 'housiy_sound_on' ? '1' : null), setItem() {} },
  CustomEvent: class {}, dispatchEvent: () => true,
  setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
  fetch: async () => ({ json: async () => ({}) }), addEventListener() {}, requestAnimationFrame: f => f(),
  SpeechSynthesisUtterance: Utter,
  speechSynthesis: { speak: u => spoken.push(u), cancel: () => { cancels++; }, resume() {}, getVoices: () => [] },
};
ctx.window = ctx; ctx.navigator = {}; vm.createContext(ctx);
vm.runInContext(src, ctx);
vm.runInContext('speechUnlocked = true; soundOn = true; callIntervalSeconds = 3;', ctx);
const digitsOf = u => u.text.match(/(\d+)$/)[1];

ctx.housiySpeakMissedNumbers([12, 15, 18]);
assert(spoken.length === 3 && spoken.map(digitsOf).join(',') === '12,15,18', 'every missed number is spoken, in call order');
assert(spoken[0].rate > spoken[2].rate, 'missed numbers are read slightly faster so the voice catches up; the newest at normal pace');

spoken.length = 0;
ctx.housiySpeakMissedNumbers(Array.from({ length: 20 }, (_, i) => i + 1));
assert(spoken.length === 6 && digitsOf(spoken[5]) === '20' && digitsOf(spoken[0]) === '15', 'a long backlog is capped to the last 6 and always ends on the newest number');

spoken.length = 0;
ctx.housiySpeakMissedNumbers([42]);
assert(spoken.length === 1 && digitsOf(spoken[0]) === '42', 'a single number behaves exactly like the normal announcement');

spoken.length = 0;
ctx.housiySpeakMissedNumbers([]);
assert(spoken.length === 0, 'empty list speaks nothing');

vm.runInContext('soundOn = false;', ctx); spoken.length = 0;
ctx.housiySpeakMissedNumbers([1, 2, 3]);
assert(spoken.length === 0, 'nothing is spoken while sound is off');

assert(/speakMissedNumbers\(newlyCalled\)/.test(player) && /previouslyCalled\.has\(n\)/.test(player), 'player snapshot path announces all newly called numbers');
assert(/speakMissedNumbers\(newlyCalled\)/.test(host) && /slice\(previousCalledCount\)/.test(host), 'host snapshot path announces all newly called numbers');
assert(/function speakNumber\(n\)/.test(src) && /number_called/.test(player), 'live WebSocket path still uses speakNumber per event');
console.log(failures ? `\n${failures} FAILED` : '\nALL MISSED-NUMBER SPEECH CHECKS PASSED'); process.exit(failures ? 1 : 0);
