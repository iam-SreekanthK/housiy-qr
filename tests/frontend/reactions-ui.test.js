'use strict';
// UI behaviour of src/assets/js/emoji-reactions.js on the REAL player and host pages.
const { ok, done, loadPage, fakeServer, players, read } = require('./harness');

const posts = (s) => s.calls.filter(c => c.method === 'POST');
const calls = (s, a) => s.calls.filter(c => c.action === a);
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));

async function suite(page) {
  const label = `[${page}]`;
  const server = fakeServer(1, players);
  const p = loadPage({ page, server });
  await p.tick();
  const { $, w, doc } = p;

  // ---- initial state
  ok($('reactionTrigger') && $('reactionTrigger').textContent.trim() === '😊', `${label} reaction button is present with the 😊 icon`);
  ok(!$('reactionModal').classList.contains('open') && $('reactionModal').getAttribute('aria-hidden') === 'true', `${label} picker starts closed`);
  ok($('reactionHistoryToggle').getAttribute('aria-expanded') === 'false' && $('reactionHistoryList').parentElement.hidden === true, `${label} history card starts collapsed`);
  ok($('reactionHistoryList').textContent.includes('No emoji reactions yet.') && $('reactionHistoryCount').textContent === '0', `${label} empty history shows placeholder and count 0`);
  ok($('reactionSend').disabled === false, `${label} Send is enabled for "Everyone"`);
  ok(calls(server, 'latest').length === 1, `${label} first visit sets a baseline (does not replay history)`);

  // ---- open / close
  click($('reactionTrigger'));
  ok($('reactionModal').classList.contains('open') && $('reactionModal').getAttribute('aria-hidden') === 'false', `${label} button opens the picker`);
  click($('reactionClose')); ok(!$('reactionModal').classList.contains('open'), `${label} × closes it`);
  click($('reactionTrigger')); click($('reactionModal')); ok(!$('reactionModal').classList.contains('open'), `${label} clicking the backdrop closes it`);
  click($('reactionTrigger')); doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })); ok(!$('reactionModal').classList.contains('open'), `${label} Escape closes it`);
  click($('reactionTrigger')); click(doc.querySelector('.reaction-modal')); ok($('reactionModal').classList.contains('open'), `${label} clicking inside the dialog keeps it open`);

  // ---- emoji grid
  const grid = [...$('reactionEmojiGrid').querySelectorAll('button')];
  ok(grid.length === 12, `${label} 12 emoji offered`);
  click(grid[4]); ok(grid[4].classList.contains('active') && grid.filter(b => b.classList.contains('active')).length === 1, `${label} selecting an emoji marks only it active`);

  // ---- send to everyone (uses the selected emoji and the room from the URL)
  click($('reactionSend')); await p.tick();
  const sent = posts(server)[0];
  ok(sent && sent.body.room_code === 'ROOM1234' && sent.body.emoji === grid[4].dataset.emoji && sent.body.target === 'everyone' && sent.body.recipient_id === null,
    `${label} POST carries room code, chosen emoji, target=everyone (${sent && JSON.stringify(sent.body)})`);
  ok(!$('reactionModal').classList.contains('open'), `${label} picker closes after sending`);
  ok(doc.querySelectorAll('.reaction-float').length === 1, `${label} sender sees their own reaction float immediately`);
  ok($('reactionHistoryCount').textContent === '1', `${label} history count updates after sending`);

  // ---- floating reaction content / placement / colour
  const fl = doc.querySelector('.reaction-float');
  ok(fl.querySelector('.reaction-float-emoji').textContent === grid[4].dataset.emoji && fl.querySelector('.reaction-float-name').textContent === 'Me', `${label} float shows emoji and sender name`);
  const left = parseFloat(fl.style.left), top = parseFloat(fl.style.top);
  ok(left >= w.innerWidth * 0.12 && left <= w.innerWidth * 0.88 && top >= 0 && top <= w.innerHeight, `${label} float starts inside the viewport safe zone (${left | 0},${top | 0})`);
  ok(/^#[0-9A-F]{6}$/i.test(fl.querySelector('.reaction-float-name').style.color) || /^rgb/.test(fl.querySelector('.reaction-float-name').style.color), `${label} name uses a palette colour`);
  const dur = parseFloat(fl.style.animationDuration); ok(dur >= 6.5 && dur <= 8, `${label} floats for 6.5–8s (${dur.toFixed(2)}s)`);
  fl.dispatchEvent(new w.Event('animationend')); ok(doc.querySelectorAll('.reaction-float').length === 0, `${label} float is removed when its animation ends`);

  // ---- private send
  click($('reactionTrigger'));
  const targets = [...doc.querySelectorAll('[data-reaction-target]')];
  click(targets[1]);
  ok(!$('reactionPlayerWrap').classList.contains('d-none') && targets[1].classList.contains('active') && !targets[0].classList.contains('active'), `${label} "Specific player" reveals the player list`);
  await p.tick();
  const opts = [...$('reactionPlayerSelect').options].map(o => o.textContent);
  ok(opts.join('|') === 'Choose a player…|Asha|Ravi|Host Hari', `${label} players list = placeholder + everyone but me (${opts.join('|')})`);
  ok($('reactionSend').disabled === true, `${label} Send is disabled until a player is chosen`);
  const before = posts(server).length; click($('reactionSend')); await p.tick();
  ok(posts(server).length === before, `${label} clicking a disabled Send posts nothing`);
  $('reactionPlayerSelect').value = '3'; $('reactionPlayerSelect').dispatchEvent(new w.Event('change'));
  ok($('reactionSend').disabled === false, `${label} choosing a player enables Send`);
  await p.advance(1000); // past the client-side toast/cooldown noise
  click($('reactionSend')); await p.tick();
  const priv = posts(server).pop();
  ok(priv.body.target === 'player' && priv.body.recipient_id === 3, `${label} private POST carries recipient_id as a number`);
  click($('reactionTrigger')); click(targets[0]);
  ok($('reactionPlayerWrap').classList.contains('d-none') && targets[0].classList.contains('active'), `${label} switching back to Everyone hides the player list`);
  click($('reactionClose'));

  // ---- receiving: poll shows other people's reactions, with the cursor
  server.add({ sender_user_id: 2, sender_name: 'Asha', recipient_user_id: null, audience: 'EVERYONE', emoji: '🔥' });
  await p.advance(1000);
  const names = [...doc.querySelectorAll('.reaction-float-name')].map(n => n.textContent);
  ok(names.includes('Asha'), `${label} reaction from another player floats with their name`);
  const polls = calls(server, 'poll'); const last = polls[polls.length - 1];
  ok(/after=\d+/.test(last.url) && !/after=0(&|$)/.test(last.url), `${label} poll uses a moving cursor (${last.url.split('?')[1]})`);
  const nBefore = doc.querySelectorAll('.reaction-float').length;
  await p.advance(3000);
  ok(doc.querySelectorAll('.reaction-float').length === nBefore, `${label} the same reaction is never shown twice`);
  server.add({ sender_user_id: 3, sender_name: 'Ravi', recipient_user_id: 2, audience: 'PLAYER', emoji: '😍' });
  await p.advance(1000);
  ok(![...doc.querySelectorAll('.reaction-float-name')].some(n => n.textContent === 'Ravi'), `${label} a private reaction for someone else is never shown`);

  // ---- history rendering
  server.add({ sender_user_id: 2, sender_name: 'Asha', recipient_user_id: 1, audience: 'PLAYER', emoji: '🎉' });
  await p.advance(6000);
  const rows = [...doc.querySelectorAll('.reaction-history-item')];
  ok(rows.length >= 3 && $('reactionHistoryCount').textContent === String(rows.length), `${label} history lists ${rows.length} items and the badge matches`);
  const priv1 = rows.find(r => r.textContent.includes('From Asha') && r.classList.contains('private'));
  ok(priv1 && priv1.classList.contains('received') && priv1.querySelector('.reaction-history-direction').textContent === 'RECEIVED' && priv1.textContent.includes('Private reaction'), `${label} received private reaction is labelled RECEIVED / Private`);
  const toAll = rows.find(r => r.textContent.includes('To everyone'));
  ok(toAll && toAll.classList.contains('sent') && toAll.classList.contains('room-wide') && toAll.textContent.includes('Room-wide reaction'), `${label} own room-wide reaction is labelled SENT / To everyone`);
  ok(rows.some(r => r.textContent.includes('To Ravi')), `${label} own private reaction reads "To Ravi"`);
  ok(rows[0].querySelector('time').getAttribute('datetime').endsWith('Z') && /\d{2}:\d{2}:\d{2}/.test(rows[0].querySelector('time').textContent), `${label} each row has a machine-readable and a HH:MM:SS time`);
  click($('reactionHistoryToggle'));
  ok($('reactionHistoryToggle').getAttribute('aria-expanded') === 'true' && $('reactionHistoryList').parentElement.hidden === false && $('reactionHistoryCard').classList.contains('room-card-expanded'), `${label} history toggle expands the card`);
  click($('reactionHistoryToggle'));
  ok($('reactionHistoryToggle').getAttribute('aria-expanded') === 'false' && $('reactionHistoryList').parentElement.hidden === true, `${label} and collapses it again`);

  // ---- XSS: names are text, never markup
  server.add({ sender_user_id: 2, sender_name: '<img src=x onerror=alert(1)>', recipient_user_id: null, audience: 'EVERYONE', emoji: '👏' });
  await p.advance(1000); await p.advance(6000);
  ok(doc.querySelectorAll('.reaction-float img, .reaction-history-item img').length === 0, `${label} a hostile display name is rendered as text (no element injected)`);
  ok([...doc.querySelectorAll('.reaction-float-name')].some(n => n.textContent === '<img src=x onerror=alert(1)>'), `${label} ...and shown literally`);

  // ---- errors
  server.failNext = { status: 429, error: 'Please wait a moment before sending another reaction.' };
  click($('reactionTrigger')); click($('reactionSend')); await p.tick();
  const toast = doc.getElementById('reactionToast');
  ok(toast && toast.classList.contains('show') && toast.textContent === 'Please wait a moment before sending another reaction.', `${label} a refused send shows the server message in a toast`);
  ok($('reactionSend').disabled === false, `${label} Send is usable again after an error`);
  await p.advance(3000); ok(!toast.classList.contains('show'), `${label} toast hides itself`);

  // ---- game over: everything locks
  server.status = 'COMPLETED';
  await p.advance(11000);
  ok($('reactionTrigger').disabled === true && /ended/.test($('reactionTrigger').title), `${label} when the game completes the button is disabled with an explanation`);
  click($('reactionTrigger')); ok(!$('reactionModal').classList.contains('open'), `${label} locked button cannot open the picker`);
  ok(doc.querySelectorAll('.reaction-float').length === 0, `${label} floating reactions are cleared`);
  const n0 = posts(server).length; click($('reactionSend')); await p.tick(); ok(posts(server).length === n0, `${label} nothing can be sent after the game ends`);
  server.add({ sender_user_id: 2, sender_name: 'Asha', recipient_user_id: null, audience: 'EVERYONE', emoji: '🥳' });
  await p.advance(3000); ok(doc.querySelectorAll('.reaction-float').length === 0, `${label} late reactions do not float once locked`);
  ok($('reactionHistoryList').querySelectorAll('.reaction-history-item').length >= 3, `${label} history stays visible after the game`);
}

async function lateServerLock() {
  // The server can say "ended" even when the client has not noticed yet.
  const server = fakeServer(1, players); const p = loadPage({ page: 'player.html', server }); await p.tick();
  server.status = 'COMPLETED'; // POST will answer 409
  click(p.$('reactionTrigger')); click(p.$('reactionSend')); await p.tick();
  ok(p.$('reactionTrigger').disabled === true, '[409] a 409 "game ended" reply locks the button immediately');
  ok(p.doc.getElementById('reactionToast').textContent.includes('ended'), '[409] and tells the user why');
}

async function roomCodeSources() {
  const s1 = fakeServer(1, players);
  const a = loadPage({ page: 'host.html', server: s1, url: 'http://localhost/host.html?room_code=abcd9999' }); await a.tick();
  ok(calls(s1, 'latest')[0].url.includes('room_code=ABCD9999'), '[room] room_code= query parameter works and is upper-cased');
  const s2 = fakeServer(1, players);
  const b = loadPage({ page: 'host.html', server: s2, url: 'http://localhost/host.html' });
  b.$('roomCodeText').textContent = ' xyz12345 '; await b.advance(2000);
  ok(s2.calls.some(c => c.url.includes('room_code=XYZ12345')), '[room] falls back to the room code shown on the page');
  const s3 = fakeServer(1, players);
  const c = loadPage({ page: 'player.html', server: s3, url: 'http://localhost/player.html' }); await c.advance(2000);
  ok(s3.calls.filter(x => x.action !== 'players').length === 0, '[room] with no room code nothing is requested');
  click(c.$('reactionTrigger')); click(c.$('reactionSend')); await c.tick();
  ok(c.$('reactionSend').disabled === true && posts(s3).length === 0, '[room] with no room code Send is disabled and nothing is posted');
}

async function cursorPersistence() {
  const server = fakeServer(1, players);
  server.add({ sender_user_id: 2, sender_name: 'Asha', recipient_user_id: null, audience: 'EVERYONE', emoji: '🔥' });
  const a = loadPage({ page: 'player.html', server }); await a.advance(2000);
  ok(a.doc.querySelectorAll('.reaction-float').length === 0, '[cursor] reactions that existed before joining are not replayed');
  ok(a.w.sessionStorage.getItem('housiy:reaction-cursor:ROOM1234') === '1', '[cursor] baseline is remembered in sessionStorage');
  server.add({ sender_user_id: 2, sender_name: 'Asha', recipient_user_id: null, audience: 'EVERYONE', emoji: '👍' });
  await a.advance(2000); ok(a.doc.querySelectorAll('.reaction-float').length === 1, '[cursor] a reaction sent after the baseline is shown');
  ok(a.w.sessionStorage.getItem('housiy:reaction-cursor:ROOM1234') === '2', '[cursor] cursor advances with every delivered reaction');
}

async function pollingModes() {
  // -- socket down: original fast polling
  let server = fakeServer(1, players); let p = loadPage({ page: 'player.html', server }); await p.tick();
  let before = calls(server, 'poll').length; await p.advance(6500);
  const fast = calls(server, 'poll').length - before;
  ok(fast >= 8 && fast <= 11, `[polling] socket down: polls about every 650ms (${fast} polls in 6.5s)`);

  // -- socket up: heartbeat only, but a signal fetches at once
  server = fakeServer(1, players); p = loadPage({ page: 'player.html', server }); await p.tick();
  p.w.rtConnected = true; await p.advance(2000);
  before = calls(server, 'poll').length; await p.advance(9000);
  ok(calls(server, 'poll').length - before <= 1, `[polling] socket up: no fast polling (${calls(server, 'poll').length - before} polls in 9s)`);
  await p.advance(3000);
  ok(calls(server, 'poll').length - before >= 1, '[polling] socket up: a 10s heartbeat poll still happens');
  const row = server.add({ sender_user_id: 2, sender_name: 'Asha', recipient_user_id: null, audience: 'EVERYONE', emoji: '🔥' });
  before = calls(server, 'poll').length;
  p.w.dispatchEvent(new p.w.CustomEvent('housiy:realtime', { detail: { type: 'reaction' } })); await p.advance(500);
  ok(calls(server, 'poll').length - before === 1 && p.doc.querySelectorAll('.reaction-float').length === 1, '[polling] a "reaction" signal fetches and shows it immediately');
  before = calls(server, 'poll').length;
  for (const t of ['number_called', 'player_joined', 'prize_won', 'game_started']) p.w.dispatchEvent(new p.w.CustomEvent('housiy:realtime', { detail: { type: t } }));
  await p.advance(500); ok(calls(server, 'poll').length === before, '[polling] unrelated game signals do not cause reaction requests');
  before = calls(server, 'poll').length;
  for (let i = 0; i < 40; i++) p.w.dispatchEvent(new p.w.CustomEvent('housiy:realtime', { detail: { type: 'reaction' } }));
  await p.advance(1000); ok(calls(server, 'poll').length - before <= 3, `[polling] a burst of 40 signals is coalesced (${calls(server, 'poll').length - before} requests)`);
  before = calls(server, 'poll').length;
  p.w.dispatchEvent(new p.w.CustomEvent('housiy:realtime', { detail: { type: 'hello' } })); await p.advance(500);
  ok(calls(server, 'poll').length - before === 1, '[polling] (re)connecting catches up with one fetch');
  server.status = 'COMPLETED';
  p.w.dispatchEvent(new p.w.CustomEvent('housiy:realtime', { detail: { type: 'game_ended' } })); await p.advance(600);
  ok(p.$('reactionTrigger').disabled === true, '[polling] a game_ended signal locks the picker without waiting for the heartbeat');

  // -- a full page of 30 means "keep going"
  server = fakeServer(1, players); p = loadPage({ page: 'player.html', server }); await p.tick();
  for (let i = 0; i < 35; i++) server.add({ sender_user_id: 2, sender_name: 'Asha', recipient_user_id: null, audience: 'EVERYONE', emoji: '👍' });
  await p.advance(2500);
  ok(p.doc.querySelectorAll('.reaction-float').length === 35, `[polling] a backlog bigger than one page is drained (${p.doc.querySelectorAll('.reaction-float').length} of 35 shown)`);

  // -- hidden tab does not poll
  server = fakeServer(1, players); p = loadPage({ page: 'player.html', server, hidden: true }); await p.tick();
  await p.advance(5000); ok(calls(server, 'poll').length === 0 && calls(server, 'latest').length === 0, '[polling] a hidden tab makes no reaction polls');
}

async function noopOnOtherPages() {
  const server = fakeServer(1, players);
  let threw = false;
  try { const p = loadPage({ page: 'index.html', server }); await p.advance(3000); ok(server.calls.length === 0, '[index] script is inert on pages without the widget'); } catch (e) { threw = true; console.log(e); }
  ok(!threw, '[index] loading the script on a page without the widget does not throw');
}

function pageWiring() {
  for (const page of ['player.html', 'host.html']) {
    const html = read(page);
    ok(/<script src="assets\/js\/emoji-reactions\.js" defer><\/script>/.test(html), `[wiring] ${page} loads emoji-reactions.js`);
    ok(/id="reactionFloatLayer"[^>]*aria-live="polite"/.test(html), `[wiring] ${page} float layer is an aria-live region`);
    ok(/role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="reactionTitle"/.test(html), `[wiring] ${page} picker is an accessible dialog`);
  }
  const css = read('assets/css/style.css');
  for (const sel of ['.reaction-trigger', '.reaction-modal-backdrop.open', '.reaction-float', '@keyframes reaction-drift', '.reaction-history-card', '.reaction-toast.show', '.reaction-send:disabled']) {
    ok(css.includes(sel), `[css] stylesheet defines ${sel}`);
  }
}

(async () => {
  await suite('player.html');
  await suite('host.html');
  await lateServerLock();
  await roomCodeSources();
  await cursorPersistence();
  await pollingModes();
  await noopOnOtherPages();
  pageWiring();
  done();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
