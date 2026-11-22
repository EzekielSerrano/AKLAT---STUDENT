'use strict';
/**
 * A.K.L.A.T. Student Web Portal — server
 * Read-only student view: dashboard, catalog search, history, profile.
 * Powered by Neon: Lakebase Postgres & Neon Realtime.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

// Load environment variables (.env.local, then .env)
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Neon Postgres driver (WebSockets over port 443)
const { Pool: NeonPool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
neonConfig.webSocketConstructor = ws;

// Neon Realtime service
const { createRealtime, rawSql } = require('@neon/realtime/server');

const scrypt = promisify(crypto.scrypt);

// ── Config ─────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SESSION_TTL_SEC = 2 * 60 * 60; // 2 hours
const RULES = { maxLoans: 5, loanDays: 7, penaltyPerDay: 5 };
const PUBLIC_DIR = path.join(__dirname, 'public');

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (PROD) {
    console.error('SESSION_SECRET is required when NODE_ENV=production.');
    process.exit(1);
  }
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] SESSION_SECRET not set — using a temporary one (logins reset on restart).');
}

// Neon Postgres connection pool
const pool = new NeonPool({
  connectionString: process.env.DATABASE_URL || undefined,
  max: 10,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

// Neon Realtime instance
let realtime = null;
if (process.env.NEON_REALTIME_SECRET && process.env.NEON_REALTIME_URL) {
  try {
    realtime = createRealtime({
      url: process.env.NEON_REALTIME_URL,
      secret: process.env.NEON_REALTIME_SECRET,
      db: 'neondb',
    });
    console.log('[neon] Realtime service initialized with endpoint:', process.env.NEON_REALTIME_URL);
  } catch (err) {
    console.error('[neon] Failed to initialize Realtime service:', err.message);
  }
}

// ── Small helpers ──────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self' wss: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function readJson(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('Invalid request.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// ── Sessions (stateless, HMAC-signed cookie) ───────────────────────
const COOKIE = 'akl_sess';

function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

function makeToken(studentId) {
  const body = Buffer.from(JSON.stringify({ sid: studentId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC })).toString('base64url');
  return body + '.' + sign(body);
}

function readSession(req) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  if (!m) return null;
  const token = m.slice(COOKIE.length + 1);
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.sid || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data.sid;
  } catch { return null; }
}

function cookieHeader(value, maxAge) {
  const secure = PROD && process.env.COOKIE_SECURE !== 'false' ? '; Secure' : '';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

// ── Passwords ──────────────────────────────────────────────────────
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const key = await scrypt(pw, salt, expected.length);
  return crypto.timingSafeEqual(key, expected);
}

const DUMMY_HASH = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);

// ── Login rate limiting (in memory) ────────────────────────────────
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function tooMany(key, max) {
  const now = Date.now();
  const e = attempts.get(key);
  if (!e || e.reset < now) return false;
  return e.count >= max;
}
function noteFail(key) {
  const now = Date.now();
  const e = attempts.get(key);
  if (!e || e.reset < now) attempts.set(key, { count: 1, reset: now + WINDOW_MS });
  else e.count++;
}
function clearFails(key) { attempts.delete(key); }
setInterval(() => { const n = Date.now(); for (const [k, v] of attempts) if (v.reset < n) attempts.delete(k); }, 5 * 60 * 1000).unref();

// ── Data access ────────────────────────────────────────────────────
async function findStudent(id) {
  const { rows } = await pool.query(
    'SELECT student_id, name, department, year_level, nfc_registered, active_loans, overdue_count ' +
    'FROM students WHERE LOWER(student_id) = LOWER($1)', [id]);
  return rows[0] || null;
}

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

async function activeLoans(studentId) {
  // Latest transaction per book decides whether it is still out.
  const { rows } = await pool.query(
    'SELECT DISTINCT ON (book_barcode) book_barcode, book_title, type, transaction_time ' +
    'FROM transactions WHERE student_id = $1 ORDER BY book_barcode, transaction_time DESC, id DESC', [studentId]);
  return rows
    .filter((r) => r.type === 'BORROWED' || r.type === 'OVERDUE')
    .map((r) => ({
      barcode: r.book_barcode,
      title: r.book_title,
      type: r.type,
      borrowedAt: r.transaction_time,
    }))
    .sort((a, b) => new Date(a.borrowedAt) - new Date(b.borrowedAt));
}

// ── API ────────────────────────────────────────────────────────────
function studentDto(s) {
  return {
    studentId: s.student_id,
    name: s.name,
    department: s.department,
    year: s.year_level,
    nfcRegistered: !!s.nfc_registered,
    activeLoans: s.active_loans,
    overdueCount: s.overdue_count,
  };
}

const GENERIC_LOGIN_ERROR = 'Incorrect Student ID or password.';

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  // Basic CSRF defence for state-changing requests
  if (method === 'POST') {
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch { /* ignore */ }
      if (!ok) return send(res, 403, { error: 'Request blocked.' });
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json'))
      return send(res, 415, { error: 'Unsupported request.' });
  }

  // ── Public routes ──
  if (method === 'GET' && route === '/api/neon/status') {
    return send(res, 200, {
      postgres: {
        configured: !!process.env.DATABASE_URL,
        branch: process.env.NEON_BRANCH || 'unknown',
        branchId: process.env.NEON_BRANCH_ID || null
      },
      realtime: {
        enabled: !!realtime,
        url: process.env.NEON_REALTIME_URL || null
      }
    });
  }

  if (method === 'GET' && route === '/api/realtime/health') {
    if (!realtime) return send(res, 503, { ok: false, error: 'Neon Realtime service not configured.' });
    try {
      const liveCheck = rawSql('SELECT 1 as live_check');
      const sealed = await realtime.seal({ query: liveCheck });
      return send(res, 200, { ok: true, sealed: !!sealed, url: process.env.NEON_REALTIME_URL });
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
  }

  if (method === 'GET' && route === '/api/realtime/books') {
    if (!realtime) return send(res, 503, { error: 'Neon Realtime service not configured.' });
    try {
      const booksQuery = rawSql('SELECT barcode, title, author, section, call_number, total_copies, available_copies FROM books ORDER BY title LIMIT 60');
      const sealed = await realtime.seal({ query: booksQuery });
      return send(res, 200, { sealed, realtimeUrl: process.env.NEON_REALTIME_URL });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }

  if (method === 'POST' && route === '/api/activate') {
    const body = await readJson(req);
    const studentId = String(body.studentId || '').trim();
    const name = String(body.name || '');
    const password = String(body.password || '');
    const ip = clientIp(req);
    const key = 'act|' + ip;
    if (tooMany(key, 10)) return send(res, 429, { error: 'Too many attempts. Please try again in 15 minutes.' });
    if (!studentId || !name.trim()) return send(res, 400, { error: 'Please enter your Student ID and full name.' });
    if (password.length < 8 || password.length > 100) return send(res, 400, { error: 'Password must be 8–100 characters.' });

    const fail = () => { noteFail(key); return send(res, 400, { error: "We couldn't verify those details. Check your Student ID and name exactly as the library has them, or visit the library counter." }); };
    const s = await findStudent(studentId);
    if (!s || normName(s.name) !== normName(name)) return fail();
    const existing = await pool.query('SELECT 1 FROM student_web_accounts WHERE student_id = $1', [s.student_id]);
    if (existing.rowCount > 0) return send(res, 409, { error: 'This account is already activated. Please sign in instead.' });

    const hash = await hashPassword(password);
    await pool.query('INSERT INTO student_web_accounts (student_id, password_hash) VALUES ($1, $2)', [s.student_id, hash]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(makeToken(s.student_id), SESSION_TTL_SEC) });
  }

  if (method === 'POST' && route === '/api/login') {
    const body = await readJson(req);
    const studentId = String(body.studentId || '').trim();
    const password = String(body.password || '');
    const ip = clientIp(req);
    const kUser = 'log|' + ip + '|' + studentId.toLowerCase();
    const kIp = 'logip|' + ip;
    if (tooMany(kUser, 6) || tooMany(kIp, 40)) return send(res, 429, { error: 'Too many attempts. Please try again in 15 minutes.' });
    if (!studentId || !password || password.length > 100) return send(res, 400, { error: GENERIC_LOGIN_ERROR });

    const { rows } = await pool.query(
      'SELECT a.student_id, a.password_hash FROM student_web_accounts a ' +
      'WHERE LOWER(a.student_id) = LOWER($1)', [studentId]);
    const acct = rows[0];
    const ok = await verifyPassword(password, acct ? acct.password_hash : DUMMY_HASH);
    if (!acct || !ok) { noteFail(kUser); noteFail(kIp); return send(res, 401, { error: GENERIC_LOGIN_ERROR }); }
    clearFails(kUser);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(makeToken(acct.student_id), SESSION_TTL_SEC) });
  }

  if (method === 'POST' && route === '/api/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
  }

  // ── Authenticated routes ──
  const sid = readSession(req);
  if (!sid) return send(res, 401, { error: 'Please sign in.' });

  if (method === 'GET' && route === '/api/me') {
    const s = await findStudent(sid);
    if (!s) return send(res, 401, { error: 'Please sign in.' }, { 'Set-Cookie': cookieHeader('', 0) });
    return send(res, 200, { student: studentDto(s), rules: RULES });
  }

  if (method === 'GET' && route === '/api/loans') {
    return send(res, 200, { loans: await activeLoans(sid) });
  }

  if (method === 'GET' && route === '/api/realtime/loans') {
    if (!realtime) return send(res, 503, { error: 'Neon Realtime service not configured.' });
    try {
      const loansQuery = rawSql(
        'SELECT DISTINCT ON (book_barcode) book_barcode, book_title, type, transaction_time FROM transactions WHERE student_id = $1 ORDER BY book_barcode, transaction_time DESC, id DESC',
        [sid]
      );
      const sealed = await realtime.seal({ query: loansQuery });
      return send(res, 200, { sealed, realtimeUrl: process.env.NEON_REALTIME_URL });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }

  if (method === 'GET' && route === '/api/history') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 500);
    const { rows } = await pool.query(
      'SELECT type, book_title, book_barcode, days_overdue, transaction_time ' +
      'FROM transactions WHERE student_id = $1 ORDER BY transaction_time DESC, id DESC LIMIT $2', [sid, limit]);
    return send(res, 200, {
      history: rows.map((r) => ({
        type: r.type, title: r.book_title, barcode: r.book_barcode,
        daysOverdue: r.days_overdue, at: r.transaction_time,
      })),
    });
  }

  if (method === 'GET' && route === '/api/sections') {
    const { rows } = await pool.query('SELECT DISTINCT section FROM books ORDER BY section');
    return send(res, 200, { sections: rows.map((r) => r.section).filter(Boolean) });
  }

  if (method === 'GET' && route === '/api/books') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const section = (url.searchParams.get('section') || '').trim().slice(0, 100);
    const availableOnly = url.searchParams.get('available') === '1';
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const { rows } = await pool.query(
      'SELECT barcode, title, author, call_number, section, total_copies, available_copies FROM books ' +
      "WHERE ($1::text = '' OR title ILIKE $2 OR author ILIKE $2 OR call_number ILIKE $2 OR isbn ILIKE $2) " +
      "AND ($3::text = '' OR section = $3) " +
      'AND ($4::boolean = false OR available_copies > 0) ' +
      'ORDER BY title LIMIT 60', [q, like, section, availableOnly]);
    return send(res, 200, {
      books: rows.map((r) => ({
        barcode: r.barcode, title: r.title, author: r.author, callNumber: r.call_number,
        section: r.section, total: r.total_copies, available: r.available_copies,
      })),
    });
  }

  return send(res, 404, { error: 'Not found.' });
}

// ── Static files ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ── Server ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      try {
        await pool.query('SELECT 1');
        return send(res, 200, {
          ok: true,
          services: {
            postgres: 'connected',
            realtime: realtime ? 'ready' : 'disabled',
          },
        });
      } catch (e) {
        return send(res, 503, { ok: false, error: e.message });
      }
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (e && e.status) return send(res, e.status, { error: e.message });
    console.error('[error]', e);
    if (!res.headersSent) return send(res, 500, { error: 'Something went wrong. Please try again.' });
    res.end();
  }
});

if (require.main === module || !process.env.VERCEL) {
  server.listen(PORT, () => console.log(`A.K.L.A.T. student portal listening on port ${PORT}`));
}

module.exports = server;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (realtime) {
      try { realtime.close(); } catch { /* ignore */ }
    }
    server.close(() => pool.end().finally(() => process.exit(0)));
  });
}
