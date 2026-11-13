'use strict';
// Shared helpers for the Node E2E tools. Same safety model as tests/load/config.js:
// only dev/uat targets, allow-listed hosts, and the server must confirm its own environment.
const mysql = require('mysql2/promise');

const TARGET_ENV = (process.env.TARGET_ENV || 'dev').toLowerCase();
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:80').replace(/\/$/, '');
const PRIZES = ['FIRST_FIVE', 'TOP_ROW', 'MIDDLE_ROW', 'BOTTOM_ROW', 'FULL_HOUSE'];

async function assertSafeTarget() {
  if (!['dev', 'uat'].includes(TARGET_ENV)) throw new Error(`SAFETY: TARGET_ENV must be dev or uat (got ${TARGET_ENV}); production is refused`);
  const allowed = (process.env.LOAD_ALLOWED_HOSTS || '127.0.0.1,localhost,host.docker.internal').split(',').map((s) => s.trim());
  const host = new URL(BASE_URL).hostname;
  if (!allowed.includes(host)) throw new Error(`SAFETY: host ${host} not in LOAD_ALLOWED_HOSTS`);
  let env;
  try { env = (await (await fetch(`${BASE_URL}/api/env.php`)).json()).env; } catch (e) { throw new Error('SAFETY: cannot verify target environment'); }
  if (env === 'prod') throw new Error('SAFETY: target reports prod');
  if (env !== TARGET_ENV) throw new Error(`SAFETY: target reports ${env}, expected ${TARGET_ENV}`);
}

function db() {
  return mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
    connectionLimit: 4, dateStrings: true,
  });
}

/** Minimal cookie-aware HTTP client for one actor (own session, own simulated client IP). */
class Client {
  constructor(label, ip) { this.label = label; this.ip = ip; this.cookie = ''; this.email = `${label}.${Date.now()}.${Math.floor(Math.random() * 1e9)}@e2e.example.com`; this.name = `E2E ${label}`; this.marks = new Set(); }
  async req(method, path, body, base = BASE_URL) {
    const h = { 'content-type': 'application/json' };
    if (this.ip) h['x-forwarded-for'] = this.ip;
    if (this.cookie) h.cookie = this.cookie;
    const t0 = process.hrtime.bigint();
    let res, text = '';
    try { res = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); text = await res.text(); }
    catch (e) { return { status: 0, error: String(e), ms: 0 }; }
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.startsWith('housiy_session=')) this.cookie = kv; }
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, headers: res.headers, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ipFor = (r, a) => `10.${Math.floor(r / 250)}.${r % 250}.${(a % 250) + 1}`;

module.exports = { TARGET_ENV, BASE_URL, PRIZES, assertSafeTarget, db, Client, sleep, ipFor };
