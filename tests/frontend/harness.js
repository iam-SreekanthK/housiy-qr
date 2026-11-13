'use strict';
// Shared jsdom harness: loads the REAL player.html / host.html markup and the
// REAL browser scripts, with a virtual clock and an in-memory fake of
// api/reactions.php (same visibility rules as the server).
const fs = require('fs'), path = require('path'), vm = require('vm');
const { JSDOM } = require('jsdom');
const SRC = path.join(__dirname, '../../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? passes++ : fails++; };
const done = () => { console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nALL PASSED (${passes})`); process.exit(fails ? 1 : 0); };

/** In-memory stand-in for src/api/reactions.php. */
function fakeServer(me, players) {
  const s = { me, players, rows: [], nextId: 1, status: 'LIVE', calls: [], failNext: null, delay: 0 };
  s.add = (row) => { const r = { id: s.nextId++, created_at: 1700000000 + s.nextId, ...row }; s.rows.push(r); return r; };
  const name = (id) => (players.find(p => p.id === id) || {}).name;
  const visible = (r) => r.audience === 'EVERYONE' || r.recipient_user_id === me || r.sender_user_id === me;
  s.handle = (url, opts) => {
    const u = new URL(url, 'http://localhost/');
    const q = u.searchParams; const method = (opts && opts.method) || 'GET';
    s.calls.push({ method, action: q.get('action') || (method === 'POST' ? 'send' : 'poll'), url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (s.failNext) { const f = s.failNext; s.failNext = null; return { status: f.status, body: { success: false, error: f.error } }; }
    if (method === 'POST') {
      const b = JSON.parse(opts.body);
      if (s.status === 'COMPLETED') return { status: 409, body: { success: false, error: 'Reactions are disabled because this game has ended.' } };
      const r = s.add({ sender_user_id: me, recipient_user_id: b.target === 'player' ? b.recipient_id : null, audience: b.target === 'player' ? 'PLAYER' : 'EVERYONE', emoji: b.emoji, sender_name: name(me) || 'Me' });
      return { status: 200, body: { success: true, id: r.id } };
    }
    const action = q.get('action') || 'poll';
    if (action === 'players') return { status: 200, body: { success: true, players: players.filter(p => p.id !== me) } };
    if (action === 'latest') return { status: 200, body: { success: true, latest_id: Math.max(0, ...s.rows.filter(visible).map(r => r.id)), room_status: s.status } };
    if (action === 'history') {
      const hist = s.rows.filter(visible).sort((a, b) => b.id - a.id).map(r => {
        const sent = r.sender_user_id === me;
        return { ...r, sender_name: r.sender_name || name(r.sender_user_id), recipient_name: name(r.recipient_user_id) || null, direction: sent ? 'SENT' : 'RECEIVED',
          other_name: sent ? (r.audience === 'EVERYONE' ? 'Everyone' : (name(r.recipient_user_id) || 'Player')) : (r.sender_name || name(r.sender_user_id) || 'Player') };
      });
      return { status: 200, body: { success: true, history: hist, room_status: s.status } };
    }
    const after = parseInt(q.get('after') || '0', 10);
    const out = s.rows.filter(r => r.id > after && visible(r)).sort((a, b) => a.id - b.id).slice(0, 30)
      .map(r => ({ ...r, sender_name: r.sender_name || name(r.sender_user_id) }));
    return { status: 200, body: { success: true, reactions: out, room_status: s.status } };
  };
  return s;
}

/** Build a page. opts: {page:'player.html'|'host.html'|'index.html', url, server, scripts:[...], hidden} */
function loadPage(opts) {
  const html = read(opts.page);
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, ''), {
    url: opts.url || 'http://localhost/' + opts.page + '?room=ROOM1234', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  // ---- virtual clock
  let now = 1_000_000, tid = 1; const timers = new Map();
  w.setInterval = (f, ms) => { const id = tid++; timers.set(id, { f, ms, every: true, next: now + ms }); return id; };
  w.clearInterval = (id) => timers.delete(id);
  w.setTimeout = (f, ms) => { const id = tid++; timers.set(id, { f, ms: ms || 0, next: now + (ms || 0) }); return id; };
  w.clearTimeout = (id) => timers.delete(id);
  const RealDate = w.Date;
  w.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  if (opts.hidden) Object.defineProperty(w.document, 'hidden', { value: true, configurable: true });
  const server = opts.server;
  w.fetch = async (url, o) => {
    if (server.delay) await new Promise(r => setImmediate(r));
    const r = server.handle(String(url), o);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  const ctx = dom.getInternalVMContext();
  const run = (code, name) => new vm.Script(code, { filename: name }).runInContext(ctx);
  for (const s of (opts.scripts || ['assets/js/emoji-reactions.js'])) run(read(s), s);
  const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      let best = null, bid = null;
      for (const [id, t] of timers) if (t.next <= end && (!best || t.next < best.next)) { best = t; bid = id; }
      if (!best) break;
      now = best.next; best.f();
      if (best.every) best.next += best.ms; else timers.delete(bid);
      await tick();
    }
    now = end; await tick();
  };
  const $ = (id) => w.document.getElementById(id);
  return { dom, w, doc: w.document, $, run, tick, advance, timers, server, get now() { return now; } };
}
const players = [{ id: 1, name: 'Me' }, { id: 2, name: 'Asha' }, { id: 3, name: 'Ravi' }, { id: 4, name: 'Host Hari' }];
module.exports = { ok, done, loadPage, fakeServer, players, read, run: null };
