'use strict';
/**
 * Housiy realtime gateway.
 *
 * PHP publishes room-change signals to Redis. The gateway relays those to
 * authorised room members; reaction events carry only the minimal reaction
 * payload needed for immediate display. Game state still comes from the same
 * ticket.php / results.php APIs. Private reaction events are user-targeted.
 * Authorisation is delegated to PHP (api/ws_auth.php) using the browser's cookies.
 *
 * Failure model: if Redis (the signal source) is unavailable the gateway
 * drops every client and refuses upgrades. Browsers fall back to throttled HTTP
 * snapshot polling (ramping down the longer the outage lasts), reconnect with
 * exponential backoff + jitter, and reconcile once from the canonical snapshot
 * API as soon as a new socket receives HELLO.
 */
const http = require('http');
const { WebSocketServer } = require('ws');
const Redis = require('ioredis');
const crypto = require('crypto');

const cfg = {
  port: parseInt(process.env.PORT || '8090', 10),
  debug: ['1', 'true', 'yes'].includes(String(process.env.WS_DEBUG || '').toLowerCase()), // verbose per-connection logs
  authUrl: process.env.WS_AUTH_URL || 'http://127.0.0.1:8080/api/ws_auth.php',
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  redisDb: parseInt(process.env.REDIS_DB || '0', 10),
  prefix: process.env.REDIS_PREFIX || 'housiy',
  heartbeatPollMs: parseInt(process.env.WS_HEARTBEAT_POLL_MS || '10000', 10),
  maxPerRoom: parseInt(process.env.WS_MAX_PER_ROOM || '110', 10), // 100 players + host/room operator
  maxConnections: Math.max(100, parseInt(process.env.WS_MAX_CONNECTIONS || '12000', 10)),
  // Disconnect slow consumers instead of allowing unbounded per-socket memory growth.
  maxBufferedBytes: Math.max(4096, parseInt(process.env.WS_MAX_BUFFERED_BYTES || '65536', 10)),
  allowedOrigins: (process.env.WS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Keep the upstream PHP connection warm. Creating a fresh TCP connection
  // for every handshake caused avoidable socket churn during connection bursts.
  authTimeoutMs: Math.max(1000, parseInt(process.env.WS_AUTH_TIMEOUT_MS || '5000', 10)),
  authMaxSockets: Math.max(8, parseInt(process.env.WS_AUTH_MAX_SOCKETS || '64', 10)),
  commandTimeoutMs: Math.max(1000, parseInt(process.env.WS_COMMAND_TIMEOUT_MS || '10000', 10)),
};

// Reuse TCP connections to the PHP-FPM-backed app across handshakes. Keep the pool bounded
// so a burst of browser reconnects cannot create an unbounded socket storm.
const authAgent = new http.Agent({
  keepAlive: true,
  maxSockets: cfg.authMaxSockets,
  maxFreeSockets: Math.min(16, cfg.authMaxSockets),
  timeout: cfg.authTimeoutMs,
});
const authHttpsAgent = new (require('https').Agent)({
  keepAlive: true,
  maxSockets: cfg.authMaxSockets,
  maxFreeSockets: Math.min(16, cfg.authMaxSockets),
  timeout: cfg.authTimeoutMs,
});
const CHANNEL = `${cfg.prefix}:events`;
const INSTANCE_ID = `${process.env.HOSTNAME || 'gateway'}-${crypto.randomBytes(4).toString('hex')}`;
const presenceRedis = new Redis({host:cfg.redisHost,port:cfg.redisPort,password:cfg.redisPassword,db:cfg.redisDb,retryStrategy:n=>Math.min(n*200,2000),enableOfflineQueue:false,maxRetriesPerRequest:1});
presenceRedis.on('error', e => log('presence redis error:', e.message));
const presenceKey = room => `${cfg.prefix}:room:${room}:presence:${INSTANCE_ID}`;
async function touchPresence(room, userId, connectionId) { try { const key=presenceKey(room); await presenceRedis.zadd(key, String(Math.floor(Date.now()/1000)), `${userId}:${connectionId}`); await presenceRedis.expire(key, 60); } catch (_) {} }
async function removePresence(room, userId, connectionId) { try { const key=presenceKey(room); await presenceRedis.zrem(key, `${userId}:${connectionId}`); } catch (_) {} }
async function refreshRoomPresence(room, clients) { try { const key=presenceKey(room), now=String(Math.floor(Date.now()/1000)), pipe=presenceRedis.pipeline(); for (const c of clients) pipe.zadd(key, now, `${c.userId}:${c.connectionId}`); pipe.expire(key, 60); await pipe.exec(); } catch (_) {} }
const EVENT_NAMES = { number_called:'NUMBER_CALLED', ticket_marked:'NUMBER_MARKED', ticket_updated:'TICKET_UPDATED', prize_claimed:'PRIZE_CLAIMED', prize_won:'WINNER_DECLARED', game_started:'GAME_STARTED', game_paused:'GAME_PAUSED', game_resumed:'GAME_RESUMED', game_ended:'GAME_FINISHED', player_joined:'PLAYER_JOINED', room_deleted:'ROOM_DELETED', rematch_created:'ROOM_STATE_SYNC', reaction:'EMOJI_REACTION' };
const COMMANDS = { MARK_NUMBER:'/api/mark.php', CLAIM_PRIZE:'/api/claim.php', SEND_EMOJI_REACTION:'/api/reactions.php', DECLINE_REMATCH:'/api/room_rematch_decline.php' };
const ROOM_RE = /^[A-Z0-9]{4,12}$/;

/** room code -> Set<{ws, userId}> */
const rooms = new Map();
let redisReady = false;
const metrics = { connections_total:0, messages_received_total:0, events_broadcast_total:0, commands_total:0, command_errors_total:0, auth_failures_total:0, broadcast_bytes_total:0 };

function log(...a) { console.log(new Date().toISOString(), ...a); }
const logWarn = (...a) => console.warn(new Date().toISOString(), ...a);
const logInfo = (...a) => console.info(new Date().toISOString(), ...a);

// ---------- Redis subscriber ----------
const sub = new Redis({
  host: cfg.redisHost, port: cfg.redisPort, password: cfg.redisPassword, db: cfg.redisDb,
  retryStrategy: (n) => Math.min(n * 200, 2000),
  enableOfflineQueue: true, maxRetriesPerRequest: null,
});
sub.on('ready', async () => {
  try {
    await sub.subscribe(CHANNEL);
    redisReady = true;
    log('redis ready, subscribed to', CHANNEL);
  } catch (e) { log('subscribe failed', e.message); }
});
function redisLost(why) {
  if (redisReady) log('redis lost:', why);
  redisReady = false;
  // Drop clients so they fall back to polling until we are healthy again.
  for (const set of rooms.values()) for (const c of set) { try { c.ws.close(1013, 'signal source unavailable'); } catch (_) {} }
}
sub.on('error', (e) => redisLost(e.message));
sub.on('close', () => redisLost('connection closed'));
sub.on('end', () => redisLost('connection ended'));

sub.on('message', (_ch, raw) => {
  let ev; try { ev = JSON.parse(raw); } catch (_) { return; }
  const eventRoom = String(ev.room || '').trim().toUpperCase();
  if (!ROOM_RE.test(eventRoom)) return;
  const set = rooms.get(eventRoom);
  if (!set) return;
  const sequence = Number.isSafeInteger(Number(ev.version)) && Number(ev.version) > 0 ? Number(ev.version) : 0;
  const eventName = EVENT_NAMES[String(ev.type || '').toLowerCase()] || 'ROOM_STATE_SYNC';
  const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
  const msg = JSON.stringify({
    event: eventName,
    event_id: String(ev.event_id || `${ev.room || 'room'}:${sequence || Date.now()}:${ev.type || 'change'}`),
    room_id: Number.isSafeInteger(Number(ev.room_id)) ? Number(ev.room_id) : Number(set.values().next().value?.roomId || 0) || null,
    room_code: eventRoom,
    occurred_at: Number(ev.occurred_at) || Math.floor(Date.now()/1000),
    sequence,
    data,
    // Backward-compatible fields for the current frontend during rollout.
    t: 'u', e: ev.type,
    ...(sequence > 0 ? { v: sequence } : {}),
    ...(ev.data && ev.type === 'reaction' ? { r: ev.data } : {}),
  });
  // `user` is null for room-wide events and a numeric user ID for targeted
  // events. Keep the same target semantics for both metrics and delivery.
  const targetUserId = ev.user == null ? null : Number(ev.user);
  if (targetUserId !== null && (!Number.isSafeInteger(targetUserId) || targetUserId <= 0)) return;
  const recipientCount = targetUserId === null ? set.size : [...set].filter(c => c.userId === targetUserId).length;
  metrics.events_broadcast_total += recipientCount;
  metrics.broadcast_bytes_total += Buffer.byteLength(msg) * recipientCount;
  for (const c of set) {
    if (targetUserId !== null && c.userId !== targetUserId) continue;
    if (c.ws.readyState !== 1) continue;
    // A slow/mobile client must not accumulate an unbounded outbound queue.
    // It can reconnect and reconcile through the canonical snapshot API.
    if (c.ws.bufferedAmount > cfg.maxBufferedBytes) {
      try { c.ws.close(1013, 'client too slow; reconnect to resync'); } catch (_) {}
      continue;
    }
    try {
      c.ws.send(msg, (err) => {
        if (err) { try { c.ws.terminate(); } catch (_) {} }
      });
    } catch (_) { try { c.ws.terminate(); } catch (_) {} }
  }
});

// ---------- Auth via PHP ----------
// Returns {userId} | {status: 429|503} (throttled / protection unavailable) | null (denied).
async function authorise(roomCode, cookie, forwardedFor) {
  const authStarted = process.hrtime.bigint();
  let authOutcome = 'unknown';
  const url = new URL(cfg.authUrl);
  url.searchParams.set('room_code', roomCode);

  try {
    const body = await new Promise((resolve, reject) => {
      const headers = { cookie: cookie || '' };
      if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

      const secure = url.protocol === 'https:';
      const transport = secure ? require('https') : http;
      const req = transport.request(url, {
        method: 'GET',
        headers,
        agent: secure ? authHttpsAgent : authAgent,
        timeout: cfg.authTimeoutMs,
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode === 429 || res.statusCode === 503) {
            logWarn(`[WS AUTH] room=${roomCode} upstream_status=${res.statusCode}`);
            return resolve({ kind: 'status', status: res.statusCode });
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            logWarn(`[WS AUTH] room=${roomCode} upstream_status=${res.statusCode}`);
            return resolve({ kind: 'denied' });
          }
          try {
            resolve({ kind: 'body', body: JSON.parse(raw) });
          } catch (_) {
            resolve({ kind: 'invalid' });
          }
        });
        res.on('error', reject);
      });

      req.on('timeout', () => {
        const err = new Error('Authentication request timed out');
        err.name = 'TimeoutError';
        req.destroy(err);
      });
      req.on('error', reject);
      req.end();
    });

    if (body.kind === 'status') {
      authOutcome = `upstream_${body.status}`;
      return { status: body.status };
    }
    if (body.kind !== 'body') {
      authOutcome = body.kind === 'invalid' ? 'invalid_response' : 'denied';
      if (body.kind === 'invalid') {
        logWarn(`[WS AUTH] room=${roomCode} upstream_status=200 invalid_auth_response`);
      }
      return null;
    }

    const result = body.body;
    if (!result || !result.success || !Number.isFinite(Number(result.user_id))) {
      authOutcome = 'denied';
      logWarn(`[WS AUTH] room=${roomCode} upstream_status=200 invalid_auth_response`);
      return null;
    }
    authOutcome = 'success';
    return { userId: Number(result.user_id), roomId: Number(result.room_id) || null };
  } catch (e) {
    authOutcome = `error_${e.name || 'Error'}`;
    logWarn(`[WS AUTH] room=${roomCode} upstream_error=${e.name || 'Error'}`);
    return null;
  } finally {
    const authMs = Number(process.hrtime.bigint() - authStarted) / 1e6;
    logInfo(`[WS AUTH TIMING] room=${roomCode} duration_ms=${authMs.toFixed(2)} outcome=${authOutcome}`);
  }
}

// Forward a small, whitelisted command to the existing PHP business endpoint.
// The browser's session cookie is forwarded; player identity is never accepted
// from the WebSocket payload. PHP repeats Auth, room membership and business validation.
async function callPhpApi(path, cookie, forwardedFor, data) {
  const base = new URL(cfg.authUrl);
  const url = new URL(path, `${base.protocol}//${base.host}`);
  const transport = url.protocol === 'https:' ? require('https') : http;
  const body = Buffer.from(JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST', agent: url.protocol === 'https:' ? authHttpsAgent : authAgent,
      timeout: cfg.commandTimeoutMs,
      headers: { 'content-type':'application/json', 'content-length':body.length, cookie:cookie || '', ...(forwardedFor ? {'x-forwarded-for':forwardedFor} : {}) },
    }, res => {
      let raw=''; res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; if (raw.length > 1024*1024) req.destroy(new Error('API response too large')); });
      res.on('end', () => { try { resolve({status:res.statusCode, body:JSON.parse(raw)}); } catch (_) { reject(new Error('Invalid API response')); } });
    });
    req.on('timeout', () => req.destroy(new Error('API command timed out')));
    req.on('error', reject); req.end(body);
  });
}

function sendError(ws, commandId, code, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify({event:'ERROR', event_id:crypto.randomBytes(16).toString('hex'), command_id:commandId, data:{code, message}}));
}

function validCommand(message, room) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  if (message.room_code && String(message.room_code).trim().toUpperCase() !== room) return false;
  const data = message.data == null ? {} : message.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const exactKeys = (allowed) => Object.keys(data).every(k => allowed.includes(k));
  switch (message.event) {
    case 'JOIN_ROOM': case 'LEAVE_ROOM': case 'REQUEST_ROOM_SYNC': case 'ACK_EVENT': case 'DECLINE_REMATCH':
      return Object.keys(data).length <= 4;
    case 'MARK_NUMBER':
      return exactKeys(['number']) && Number.isInteger(data.number) && data.number >= 1 && data.number <= 90;
    case 'CLAIM_PRIZE':
      return exactKeys(['prize_type']) && typeof data.prize_type === 'string' && /^[A-Z_]{3,24}$/.test(data.prize_type);
    case 'SEND_EMOJI_REACTION':
      return exactKeys(['emoji', 'target', 'recipient_id', 'idempotency_key', 'room_code']) &&
        (!data.room_code || String(data.room_code).trim().toUpperCase() === room) &&
        typeof data.emoji === 'string' && data.emoji.length > 0 && data.emoji.length <= 16 &&
        (data.target === 'everyone' || data.target === 'player') &&
        (data.target === 'everyone'
          ? (data.recipient_id === null || data.recipient_id === undefined)
          : Number.isSafeInteger(data.recipient_id) && data.recipient_id > 0) &&
        (data.idempotency_key === undefined ||
          (typeof data.idempotency_key === 'string' && /^[a-f0-9]{32}$/i.test(data.idempotency_key)));
    default: return false;
  }
}

// ---------- HTTP + WS ----------
const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/metrics') {
    const connections = [...rooms.values()].reduce((n, set) => n + set.size, 0);
    const body = req.url === '/metrics' ? `housiy_ws_connections ${connections}\nhousiy_ws_rooms ${rooms.size}\nhousiy_ws_redis_ready ${redisReady ? 1 : 0}\n${Object.entries(metrics).map(([k,v]) => `housiy_ws_${k} ${v}`).join('\n')}\n` : JSON.stringify({ ok: redisReady, rooms: rooms.size, connections });
    res.writeHead(redisReady ? 200 : 503, { 'content-type': req.url === '/metrics' ? 'text/plain; version=0.0.4' : 'application/json' });
    return res.end(body);
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client; cookies still required
  if (cfg.allowedOrigins.length) return cfg.allowedOrigins.includes(origin);
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}
function reject(socket, code, text, detail = '') {
  // Include the exact rejection reason in container logs; browser DevTools
  // otherwise reports only a generic WebSocket connection failure.
  log(`upgrade rejected status=${code} reason=${text}${detail ? ` detail=${detail}` : ''}`);
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch (_) { return reject(socket, 400, 'Bad Request'); }
  if (u.pathname !== '/ws') return reject(socket, 404, 'Not Found');
  if (!redisReady) return reject(socket, 503, 'Service Unavailable', 'redis_not_ready');
  if (!originAllowed(req)) return reject(socket, 403, 'Forbidden', `origin=${req.headers.origin || ''} host=${req.headers.host || ''}`);

  const rawRoom = u.searchParams.get('room');
  const room = String(rawRoom || '').trim().toUpperCase();
  const roomValid = ROOM_RE.test(room);
  
  if (!roomValid) {
    if (cfg.debug) log('INVALID ROOM CODE DEBUG', { requestUrl: req.url, rawRoom: JSON.stringify(rawRoom), length: room.length, regex: ROOM_RE.toString() });
    return reject(socket, 400, 'Bad Request', 'invalid_room_code');
  }
  
  if (cfg.debug) log('ROOM CODE ACCEPTED', { room, length: room.length });
  const totalConnections = [...rooms.values()].reduce((n, set) => n + set.size, 0);
  if (totalConnections >= cfg.maxConnections) return reject(socket, 503, 'Gateway Full', 'connection_limit');

  socket.on('error', () => {});
  // Append the TCP peer to whatever chain the proxy in front of us sent.
  const peer = req.socket.remoteAddress || '';
  const chain = [req.headers['x-forwarded-for'], peer].filter(Boolean).join(', ');
  const who = await authorise(room, req.headers.cookie, chain);
  if (who && who.status === 429) return reject(socket, 429, 'Too Many Requests', `auth_rate_limited room=${room}`);
  if (who && who.status === 503) return reject(socket, 503, 'Service Unavailable', `auth_unavailable room=${room}`);
  if (!who) { metrics.auth_failures_total++; return reject(socket, 401, 'Unauthorized', `auth_denied room=${room}`); }
  if (socket.destroyed) return;
  // Replace a stale/duplicate connection for the same authenticated user in
  // this room before applying the seat-aligned connection limit.
  const existing = rooms.get(room);
  if (existing) for (const old of [...existing]) {
    if (old.userId === who.userId) { existing.delete(old); void removePresence(room, old.userId, old.connectionId); try { old.ws.close(4001, 'replaced by newer connection'); } catch (_) {} }
  }
  if ((rooms.get(room) || new Set()).size >= cfg.maxPerRoom) return reject(socket, 503, 'Room Full', `room=${room}`);

  wss.handleUpgrade(req, socket, head, async (ws) => {
    // Read the room's committed event sequence before registering this socket.
    // The browser immediately fetches a canonical snapshot after HELLO, which
    // covers the tiny subscribe/HELLO race without replaying transient events.
    let roomSequence = 0;
    try { roomSequence = Math.max(0, Number(await presenceRedis.get(`${cfg.prefix}:room:${room}:v`)) || 0); } catch (_) {}
    if (ws.readyState !== 1) return;
    const connectionId = crypto.randomBytes(8).toString('hex');
    const client = { ws, userId: who.userId, roomId: who.roomId, roomCode: room, connectionId, alive: true };
    metrics.connections_total++;
    void touchPresence(room, who.userId, connectionId);
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', async (raw) => {
      metrics.messages_received_total++;
      let msg; try { msg = JSON.parse(String(raw)); } catch (_) { return sendError(ws, null, 'INVALID_JSON', 'Invalid JSON message'); }
      const commandId = typeof msg.command_id === 'string' && msg.command_id.length <= 80 ? msg.command_id : null;
      if (!validCommand(msg, room)) return sendError(ws, commandId, 'INVALID_EVENT', 'Unsupported event or invalid payload');
      const reply = (event, data) => { if (ws.readyState === 1) ws.send(JSON.stringify({event, event_id:crypto.randomBytes(16).toString('hex'), room_id:who.roomId, room_code:room, sequence:0, command_id:commandId, data})); };
      if (msg.event === 'LEAVE_ROOM') { reply('COMMAND_RESULT', {success:true, event:'LEAVE_ROOM'}); try { ws.close(1000, 'left room'); } catch (_) {} return; }
      if (msg.event === 'JOIN_ROOM' || msg.event === 'REQUEST_ROOM_SYNC') { reply('ROOM_STATE_SYNC', {reason:msg.event.toLowerCase(), snapshot_required:true}); return; }
      if (msg.event === 'ACK_EVENT') { return; }
      const path = COMMANDS[msg.event];
      metrics.commands_total++;
      const payload = {...(msg.data || {}), room_code:room};
      try {
        const result = await callPhpApi(path, req.headers.cookie, chain, payload);
        const succeeded = result.status >= 200 && result.status < 300 && !!result.body?.success;
        reply(msg.event === 'MARK_NUMBER' && !succeeded ? 'MARK_REJECTED' : 'COMMAND_RESULT', {success:succeeded, request_event:msg.event, response:result.body});
        if (msg.event === 'DECLINE_REMATCH' && succeeded) {
          // The decision is persisted by PHP before this socket is closed.
          setTimeout(() => { try { ws.close(1000, 'rematch declined'); } catch (_) {} }, 25);
        }
      } catch (err) {
        metrics.command_errors_total++;
        log(`command failed room=${room} event=${msg.event} user=${who.userId} error=${err.name || 'Error'}`);
        sendError(ws, commandId, 'COMMAND_UNAVAILABLE', 'Command could not be processed; retry after reconnect');
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      const set = rooms.get(room);
      if (set) { set.delete(client); if (!set.size) rooms.delete(room); }
      void removePresence(room, who.userId, connectionId);
    });
    ws.send(JSON.stringify({event:'HELLO', event_id:crypto.randomBytes(16).toString('hex'), room_id:who.roomId, room_code:room, sequence:roomSequence, data:{heartbeat_interval_ms:cfg.heartbeatPollMs}, t:'hello', hb:cfg.heartbeatPollMs}));
  });
});

const pinger = setInterval(() => {
  for (const [room, set] of rooms) {
    void refreshRoomPresence(room, set);
    for (const c of set) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false; try { c.ws.ping(); } catch (_) {}
    }
  }
}, 25000);
pinger.unref();

if (require.main === module) {
  server.listen(cfg.port, () => log(`gateway listening on :${cfg.port}`));
  const stop = () => { log('shutting down'); clearInterval(pinger); for (const set of rooms.values()) for (const c of set) { try { c.ws.close(1012, 'gateway restarting'); } catch (_) {} } wss.close(); server.close(() => { Promise.allSettled([sub.quit(), presenceRedis.quit()]).finally(() => process.exit(0)); }); setTimeout(() => process.exit(1), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { server, rooms, cfg, authAgent, authHttpsAgent };
