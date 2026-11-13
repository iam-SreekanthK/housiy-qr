'use strict';
process.env.TZ = 'Asia/Kolkata'; // fixed zone so local-time assertions are deterministic
// The other emoji-build UI changes: collapsible room cards + participants
// counter (inline script of player.html / host.html), HH:MM:SS winner times,
// "claimed by me" styling hooks.
const { ok, done, loadPage, fakeServer, players, read } = require('./harness');

const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
const inlineScript = (page) => { const m = [...read(page).matchAll(/<script>([\s\S]*?)<\/script>/g)]; return m[m.length - 1][1]; };
const addPlayers = (doc, n) => { const list = doc.getElementById('playersList'); list.innerHTML = ''; for (let i = 0; i < n; i++) { const d = doc.createElement('div'); d.className = 'player-row'; d.textContent = 'P' + i; list.appendChild(d); } };

async function cards(page) {
  const L = `[${page} cards]`;
  const p = loadPage({ page, server: fakeServer(1, players), scripts: ['assets/js/emoji-reactions.js'] });
  p.run(inlineScript(page), 'inline');
  const doc = p.doc, card = doc.querySelector('[data-room-card="players"]'), toggle = card.querySelector('.room-card-toggle');
  const chevron = card.querySelector('.room-card-chevron'), content = card.querySelector('.room-card-content'), list = doc.getElementById('playersList');
  await p.advance(600);
  ok(doc.getElementById('participantsCount').textContent === '0', `${L} placeholder text is not counted as a participant`);

  addPlayers(doc, 3); await p.tick();
  ok(doc.getElementById('participantsCount').textContent === '3', `${L} heading counts 3 participants`);
  ok(toggle.hidden === true && content.hidden === false && !list.classList.contains('participants-clamped'), `${L} 5 or fewer: no expand control, nothing hidden`);
  ok(toggle.hidden === true && !card.classList.contains('players-list-long'), `${L} 5 or fewer: expand control is hidden`);
  addPlayers(doc, 5); await p.tick();
  ok(toggle.hidden === true && doc.getElementById('participantsCount').textContent === '5', `${L} exactly 5 is still the short layout`);

  addPlayers(doc, 8); await p.tick();
  ok(doc.getElementById('participantsCount').textContent === '8', `${L} heading counts 8 participants`);
  ok(toggle.hidden === false && toggle.textContent.includes('Show all') && card.classList.contains('players-list-long'), `${L} more than 5: Show all control appears`);
  ok(list.classList.contains('participants-clamped') && toggle.getAttribute('aria-expanded') === 'false', `${L} more than 5: list starts clamped to the first five`);
  click(toggle);
  ok(toggle.getAttribute('aria-expanded') === 'true' && toggle.textContent.includes('Hide') && !list.classList.contains('participants-clamped') && card.classList.contains('room-card-expanded'), `${L} clicking expands the whole list and offers Hide`);
  addPlayers(doc, 9); await p.tick();
  ok(toggle.getAttribute('aria-expanded') === 'true' && !list.classList.contains('participants-clamped'), `${L} an expanded list stays expanded when a player joins`);
  click(toggle);
  ok(toggle.getAttribute('aria-expanded') === 'false' && toggle.textContent.includes('Show all') && list.classList.contains('participants-clamped'), `${L} clicking again clamps it and offers Show all`);
  addPlayers(doc, 2); await p.tick();
  ok(toggle.hidden === true && !list.classList.contains('participants-clamped') && content.hidden === false, `${L} shrinking back to 5 or fewer restores the short layout`);
  click(toggle); ok(!list.classList.contains('participants-clamped'), `${L} short lists ignore clicks`);

  const winners = doc.querySelector('[data-room-card="winners"]');
  ok(winners.querySelector('.room-card-static-head') && !winners.querySelector('.room-card-toggle'), `${L} Winners card has a static heading (always visible)`);
  const details = doc.querySelector('[data-room-card="details"]');
  ok(details.classList.contains('d-none') && details.querySelector('.room-card-static-head'), `${L} Game Details card is hidden until the game has started, static heading`);
  for (const id of ['gdStartTime', 'gdEndTime', 'gdDuration']) ok(doc.getElementById(id), `${L} #${id} exists for the renderer`);
  const rx = doc.querySelector('[data-room-card="reactions"]');
  ok(rx.querySelector('#reactionHistoryToggle') && rx.querySelector('.room-card-content').hidden === true, `${L} reaction history card is collapsible and starts closed`);
  const before = rx.querySelector('.room-card-content').hidden;
  click(doc.getElementById('reactionHistoryToggle'));
  ok(rx.querySelector('.room-card-content').hidden !== before, `${L} the generic card handler does not double-handle the reactions toggle`);
}

async function formatting() {
  const server = fakeServer(1, players);
  const p = loadPage({ page: 'player.html', server, scripts: ['assets/js/common.js'] });
  p.run('this.__f = { formatLocalTimeSeconds, formatLocalTime, renderPlayers: typeof renderPlayersList === "function" ? renderPlayersList : null }', 'probe');
  const f = p.w.__f;
  ok(f.formatLocalTimeSeconds('2026-01-01 12:57:54') === '18:27:54', `[format] UTC 12:57:54 -> local (IST) 18:27:54, with seconds (${f.formatLocalTimeSeconds('2026-01-01 12:57:54')})`);
  ok(f.formatLocalTimeSeconds('2026-01-01 18:30:05') === '00:00:05', `[format] midnight is 00:00:05, not 24:00:05 (${f.formatLocalTimeSeconds('2026-01-01 18:30:05')})`);
  ok(f.formatLocalTimeSeconds('2026-01-01 00:00:00') === '05:30:00', '[format] zero-padded 24-hour clock');
  ok(f.formatLocalTimeSeconds('2026-01-01 23:59:59') === '05:29:59', '[format] rolls over the day boundary correctly');
  ok(f.formatLocalTimeSeconds(null) === '—' && f.formatLocalTimeSeconds('') === '—' && f.formatLocalTimeSeconds('not a date') === '—', '[format] missing / invalid input shows an em dash');
  ok(!/AM|PM/i.test(f.formatLocalTimeSeconds('2026-01-01 12:57:54')), '[format] never 12-hour');
  ok(f.formatLocalTime('2026-01-01 12:57:54') !== f.formatLocalTimeSeconds('2026-01-01 12:57:54'), '[format] the existing minute-level formatter is unchanged and distinct');

  // renderPlayers keeps the heading counter in sync
  const doc = p.doc, box = doc.createElement('div'); doc.body.appendChild(box);
  ok(typeof f.renderPlayers === 'function', '[players] renderPlayersList exists');
  if (typeof f.renderPlayers === 'function') {
    f.renderPlayers(box, [{ id: 1, name: 'A', email: 'a@x', is_host: true }, { id: 2, name: 'B', email: 'b@x', is_host: false }]);
    ok(doc.getElementById('participantsCount').textContent === '2', '[players] heading count follows the rendered list (host included)');
    ok(box.textContent.includes('A') && box.textContent.includes('B'), '[players] list rows are rendered');
    f.renderPlayers(box, []);
    ok(doc.getElementById('participantsCount').textContent === '0', '[players] empty list -> count 0');
    f.renderPlayers(box, null);
    ok(doc.getElementById('participantsCount').textContent === '0' && box.textContent.trim().length > 0, '[players] null is treated as an empty list (placeholder shown, no crash)');
    f.renderPlayers(box, undefined); ok(doc.getElementById('participantsCount').textContent === '0', '[players] undefined is safe too');
    const idx = loadPage({ page: 'index.html', server, scripts: ['assets/js/common.js'] }); idx.run('this.__r = renderPlayersList', 'p');
    let threw = false; try { idx.w.__r(idx.doc.createElement('div'), [{ id: 1, name: 'A', email: 'a', is_host: false }]); } catch (_) { threw = true; }
    ok(!threw, '[players] works on pages that have no participants counter');
  }
}

function hooks() {
  for (const page of ['page-player.js', 'page-host.js']) {
    const js = read('assets/js/' + page);
    ok(/classList\.add\('claimed', 'claimed-self'\)/.test(js), `[claim] ${page} marks the claimant's own button claimed-self`);
    ok(/classList\.add\('claimed'\);/.test(js), `[claim] ${page} still marks other players' wins plain "claimed"`);
    ok(js.includes('formatLocalTimeSeconds(w.claimed_at)') && !js.includes('formatLocalTime(w.claimed_at)'), `[claim] ${page} shows winner times with seconds`);
  }
  const css = read('assets/css/style.css');
  ok(/claim-btn\.claimed-self/.test(css), '[claim] stylesheet styles claimed-self (own prize stays green)');
  ok(/claim-btn\.claimed[^-]/.test(css) && /#E5E5E5/i.test(css), '[claim] stylesheet greys prizes claimed by others');
  ok(/\.collapsible-room-card/.test(css) && /\.participants-clamped/.test(css) && /\.room-card-static-head/.test(css), '[cards] stylesheet has the collapsible-card rules');
  ok(/\.status-meta-row/.test(css), '[layout] status row rule present');
  for (const page of ['player.html', 'host.html']) {
    const html = read(page);
    ok(/class="[^"]*status-meta-row[^"]*"/.test(html), `[layout] ${page} uses the status-meta-row layout`);
    ok(/Participants \(<span id="participantsCount">0<\/span>\)/.test(html), `[cards] ${page} heading reads "Participants (n)"`);
    ok(html.indexOf('Winners') < html.indexOf('Participants'), `[cards] ${page} order: Winners above Participants`);
  }
}

(async () => {
  await cards('player.html');
  await cards('host.html');
  await formatting();
  hooks();
  done();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
