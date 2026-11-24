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

// Neon Realtime service (dynamically imported below to avoid ERR_REQUIRE_ESM)

const scrypt = promisify(crypto.scrypt);

// ── Config ─────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SESSION_TTL_SEC = 2 * 60 * 60; // 2 hours
const RULES = { maxLoans: 5, loanDays: 7, penaltyPerDay: 5 };
const PUBLIC_DIR = path.join(__dirname, 'public');

let SECRET = process.env.SESSION_SECRET || 'dev_secret_for_aklat_student_portal_neon_setup_1234567890';
if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET not set in environment — using default fallback secret.');
}

// Neon Postgres connection pool
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || undefined;
const pool = new NeonPool({
  connectionString: dbUrl,
  max: 10,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

let tablesInitPromise = null;
async function ensureTables() {
  if (tablesInitPromise) return tablesInitPromise;
  tablesInitPromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS students (
          student_id VARCHAR(30) PRIMARY KEY,
          name TEXT NOT NULL,
          department TEXT,
          year_level TEXT,
          nfc_registered BOOLEAN DEFAULT false,
          active_loans INT DEFAULT 0,
          overdue_count INT DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS student_web_accounts (
          student_id VARCHAR(30) PRIMARY KEY REFERENCES students(student_id) ON UPDATE CASCADE ON DELETE CASCADE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS books (
          barcode VARCHAR(50) PRIMARY KEY,
          title TEXT NOT NULL,
          author TEXT,
          call_number TEXT,
          section TEXT,
          isbn TEXT,
          total_copies INT DEFAULT 1,
          available_copies INT DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS transactions (
          id SERIAL PRIMARY KEY,
          book_barcode VARCHAR(50),
          book_title TEXT,
          student_id VARCHAR(30) REFERENCES students(student_id),
          type TEXT NOT NULL,
          transaction_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          days_overdue INT DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS password_reset_otps (
          id SERIAL PRIMARY KEY,
          student_id VARCHAR(30) NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
          otp_hash TEXT NOT NULL,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          used BOOLEAN DEFAULT false,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Remove temporary dummy books
      await pool.query("DELETE FROM books WHERE barcode IN ('B-001', 'B-002');");

      // Sync books catalog from librarian inventory
      await pool.query(`
        INSERT INTO books (barcode, title, author, call_number, section, isbn, total_copies, available_copies)
        VALUES
          ('BK-00211', 'Chemistry for Engineering Students', 'Zumdahl, S.', 'QD31.3 .Z86', 'Engineering', '9781305434776', 3, 0),
          ('BK-00397', 'Engineering Mathematics', 'Bird, J.', 'TA330 .B57', 'Engineering', '9781138673595', 4, 0),
          ('BK-00492', 'Data Structures and Algorithms', 'Cormen et al.', 'QA76.9.D35 C67', 'Science & Tech', '9780262033848', 5, 2),
          ('BK-00501', 'Fundamentals of Physics', 'Halliday et al.', 'QC21.3 .H35', 'Science & Tech', '9781118230718', 6, 5),
          ('BK-00652', 'Introduction to Psychology', 'Myers, D.', 'BF121 .M94', 'Humanities', '9781464108556', 2, 1),
          ('BK-00798', 'Calculus: Early Transcendentals', 'Stewart, J.', 'QA303.2 .S74', 'Science & Tech', '9781285741550', 5, 3),
          ('BK-00799', 'A Game Of Thrones', 'Daniel Abraham', 'PS3563.A78 G36', 'General Circulation', '9780553103540', 5, 3),
          ('BK-00800', 'Harry Potter and the Sorcerer''s Stone', 'J. K. Rowling', 'PR6068.O93 H37', 'General Circulation', '9780590353403', 1, 1)
        ON CONFLICT (barcode) DO UPDATE SET
          title = EXCLUDED.title,
          author = EXCLUDED.author,
          section = EXCLUDED.section,
          total_copies = EXCLUDED.total_copies,
          available_copies = EXCLUDED.available_copies;
      `);
      console.log('[db] Tables and books synced successfully.');
    } catch (e) {
      console.error('[db] Table creation error:', e.message);
      tablesInitPromise = null;
      throw e;
    }
  })();
  return tablesInitPromise;
}

// Neon Realtime instance (lazy dynamic import to prevent ERR_REQUIRE_ESM in Vercel)
let realtime = null;
let rawSql = null;
let realtimeInitPromise = null;

async function getRealtime() {
  if (realtimeInitPromise) return realtimeInitPromise;
  if (!process.env.NEON_REALTIME_SECRET || !process.env.NEON_REALTIME_URL) {
    return null;
  }
  realtimeInitPromise = (async () => {
    try {
      const mod = await import('@neon/realtime/server');
      rawSql = mod.rawSql;
      const createRealtime = mod.createRealtime;
      realtime = createRealtime({
        url: process.env.NEON_REALTIME_URL,
        secret: process.env.NEON_REALTIME_SECRET,
        db: 'neondb',
      });
      console.log('[neon] Realtime service initialized with endpoint:', process.env.NEON_REALTIME_URL);
      return realtime;
    } catch (err) {
      console.error('[neon] Failed to initialize Realtime service:', err.message);
      realtime = null;
      return null;
    }
  })();
  return realtimeInitPromise;
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
  const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

function readJson(req, limit = 10 * 1024) {
  if (req.body) {
    try {
      return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
    } catch {
      return Promise.reject(Object.assign(new Error('Invalid request.'), { status: 400 }));
    }
  }
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

// ── Resend Email Integration ──────────────────────────────────────
function studentToEmail(studentId) {
  const cleanId = String(studentId || '').trim();
  return `${cleanId}@g.batstate-u.edu.ph`;
}

function maskEmail(email) {
  const [user, domain] = email.split('@');
  if (!user || !domain) return email;
  const visible = user.slice(0, Math.min(3, user.length));
  return `${visible}****@${domain}`;
}

// ── Email Integration (Gmail SMTP / Resend) ────────────────────────
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) {}

async function sendEmailViaResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'RESEND_API_KEY_MISSING' };
  }
  const from = process.env.RESEND_FROM || 'AKLAT Library <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('[Resend Error]', data);
    throw new Error(data.message || 'Failed to send verification email via Resend.');
  }
  return { ok: true, provider: 'resend', data };
}

async function sendEmail({ to, subject, html }) {
  const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER || 'serranoezekielaron24@gmail.com';
  const smtpPass = process.env.SMTP_PASS || process.env.GMAIL_PASS || 'ctiazqwrqwwabmnk';

  // 1. Prefer Gmail SMTP if credentials provided (works with all @g.batstate-u.edu.ph)
  if (smtpUser && smtpPass) {
    if (!nodemailer) nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: smtpUser.trim(),
        pass: smtpPass.replace(/\s+/g, '').trim(),
      },
    });

    const info = await transporter.sendMail({
      from: `"A.K.L.A.T. Library" <${smtpUser.trim()}>`,
      to,
      subject,
      html,
    });
    return { ok: true, provider: 'gmail', messageId: info.messageId };
  }

  // 2. Fall back to Resend if RESEND_API_KEY provided
  if (process.env.RESEND_API_KEY) {
    return await sendEmailViaResend({ to, subject, html });
  }

  // 3. Neither configured
  return { ok: false, error: 'NO_EMAIL_CONFIG' };
}

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
  await ensureTables();
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
      try {
        const originHost = new URL(origin).host;
        const reqHost = req.headers['x-forwarded-host'] || req.headers.host;
        ok = originHost === reqHost || originHost === req.headers.host;
      } catch { /* ignore */ }
      if (!ok) return send(res, 403, { error: 'Request blocked.' });
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json'))
      return send(res, 415, { error: 'Unsupported request.' });
  }

  // ── Public routes ──
  if (method === 'GET' && route === '/api/neon/status') {
    await getRealtime();
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
    await getRealtime();
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
    await getRealtime();
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
    let s = await findStudent(studentId);
    if (!s) {
      // If student not found, check if students table is empty or needs initial student
      const { rows } = await pool.query('SELECT COUNT(*) as count FROM students');
      const count = parseInt(rows[0].count, 10);
      if (count === 0) {
        // Auto-seed this student on fresh/empty database
        await pool.query(
          'INSERT INTO students (student_id, name, department, year_level, nfc_registered, active_loans, overdue_count) VALUES ($1, $2, $3, $4, $5, 0, 0)',
          [studentId, name, 'College of Information Technology', '1st Year', false]
        );
        s = await findStudent(studentId);
      } else {
        return fail();
      }
    } else if (normName(s.name) !== normName(name)) {
      return fail();
    }
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

  // ── Forgot Password: Step 1 — Send 6-Digit Code to GSuite Email via Resend ──
  if (method === 'POST' && route === '/api/forgot-password/request') {
    await ensureTables();
    const body = await readJson(req);
    const studentId = String(body.studentId || '').trim();
    const ip = clientIp(req);
    const key = 'fp_req|' + ip;
    if (tooMany(key, 8)) return send(res, 429, { error: 'Too many requests. Please try again in 15 minutes.' });
    if (!studentId) return send(res, 400, { error: 'Please enter your Student ID / SR-Code.' });

    const s = await findStudent(studentId);
    if (!s) return send(res, 400, { error: 'Student ID not found in library records.' });

    const existing = await pool.query('SELECT 1 FROM student_web_accounts WHERE student_id = $1', [s.student_id]);
    if (existing.rowCount === 0) {
      return send(res, 400, { error: 'This account has not been activated yet. Please click "First time? Activate" first.' });
    }

    // Generate 6-digit OTP
    const otp = String(crypto.randomInt(100000, 1000000));
    const otpHash = crypto.createHash('sha256').update(otp + SECRET).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    // Invalidate any active previous OTPs for this student
    await pool.query('UPDATE password_reset_otps SET used = true WHERE student_id = $1 AND used = false', [s.student_id]);
    await pool.query(
      'INSERT INTO password_reset_otps (student_id, otp_hash, expires_at) VALUES ($1, $2, $3)',
      [s.student_id, otpHash, expiresAt]
    );

    const studentEmail = studentToEmail(s.student_id);
    const emailHtml = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; background: #ffffff; border-radius: 14px; border: 1px solid #E8EDF5;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h2 style="color: #12163A; margin: 0 0 4px; font-size: 22px;">A.K.L.A.T. Library</h2>
          <p style="color: #7E8EB0; font-size: 13px; margin: 0;">Batangas State University · The National Engineering University</p>
        </div>
        <p style="color: #141926; font-size: 14px; margin: 0 0 14px;">Hello <b>${s.name}</b>,</p>
        <p style="color: #5A6480; font-size: 13.5px; line-height: 1.5; margin: 0 0 20px;">We received a request to reset your A.K.L.A.T. Student Portal password. Use the verification code below to complete the reset:</p>
        <div style="background: #F8FAFD; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0; border: 1.5px solid #DCE2F0;">
          <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #CC2936; font-family: Consolas, monospace;">${otp}</div>
          <p style="color: #7E8EB0; font-size: 12px; margin: 10px 0 0; font-weight: 600;">Valid for 10 minutes</p>
        </div>
        <p style="color: #7E8EB0; font-size: 12.5px; line-height: 1.5; margin: 20px 0 0;">If you did not request a password reset, you can safely ignore this email — your account remains secure.</p>
        <hr style="border: 0; border-top: 1px solid #E8EDF5; margin: 24px 0 16px;" />
        <p style="color: #A0ACBF; font-size: 11px; text-align: center; margin: 0;">Automated Key Library Analytics & Tracking · BatStateU</p>
      </div>
    `;

    const emailResult = await sendEmail({
      to: studentEmail,
      subject: `${otp} is your A.K.L.A.T. password reset code`,
      html: emailHtml,
    }).catch((err) => ({ ok: false, error: err.message || 'Failed to dispatch email.' }));

    if (!emailResult.ok && emailResult.error !== 'NO_EMAIL_CONFIG') {
      console.error('[Email Dispatch Error]', emailResult);
      return send(res, 500, { error: emailResult.error || 'Failed to send verification email. Please check email/SMTP settings.' });
    }

    if (emailResult.error === 'NO_EMAIL_CONFIG') {
      console.log(`[TEST/DEV OTP] Student ${s.student_id} (${studentEmail}): OTP = ${otp}`);
    }

    return send(res, 200, {
      ok: true,
      email: maskEmail(studentEmail),
      provider: emailResult.provider || 'test',
    });
  }

  // ── Forgot Password: Step 2 — Verify Code & Set New Password ──
  if (method === 'POST' && (route === '/api/forgot-password/verify' || route === '/api/reset-password')) {
    await ensureTables();
    const body = await readJson(req);
    const studentId = String(body.studentId || '').trim();
    const otp = String(body.otp || '').trim();
    const password = String(body.password || '');
    const ip = clientIp(req);
    const key = 'fp_ver|' + ip;

    if (tooMany(key, 12)) return send(res, 429, { error: 'Too many attempts. Please try again in 15 minutes.' });
    if (!studentId || !password) return send(res, 400, { error: 'Please enter your Student ID and new password.' });
    if (password.length < 8 || password.length > 100) return send(res, 400, { error: 'Password must be 8–100 characters.' });

    // If OTP is provided, verify against password_reset_otps
    if (otp) {
      const { rows } = await pool.query(
        'SELECT id, otp_hash FROM password_reset_otps WHERE LOWER(student_id) = LOWER($1) AND used = false AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
        [studentId]
      );
      if (!rows.length) {
        return send(res, 400, { error: 'Verification code has expired or is invalid. Please request a new code.' });
      }

      const expectedHash = crypto.createHash('sha256').update(otp + SECRET).digest('hex');
      if (rows[0].otp_hash !== expectedHash) {
        noteFail(key);
        return send(res, 400, { error: 'Incorrect 6-digit code. Please check your institutional email and try again.' });
      }

      await pool.query('UPDATE password_reset_otps SET used = true WHERE id = $1', [rows[0].id]);
    } else if (body.name) {
      // Fallback: name verification
      const s = await findStudent(studentId);
      if (!s || normName(s.name) !== normName(body.name)) {
        return send(res, 400, { error: "We couldn't verify those details." });
      }
    } else {
      return send(res, 400, { error: 'Please enter the 6-digit verification code sent to your email.' });
    }

    const hash = await hashPassword(password);
    await pool.query('UPDATE student_web_accounts SET password_hash = $1 WHERE LOWER(student_id) = LOWER($2)', [hash, studentId]);
    clearFails(key);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(makeToken(studentId), SESSION_TTL_SEC) });
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
    await getRealtime();
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
    await ensureTables();
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

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !rel) rel = '/index.html';
  const cleanRel = rel.replace(/^\/+/, '');

  const candidates = [
    path.join(__dirname, 'public', cleanRel),
    path.join(__dirname, cleanRel),
    path.join(process.cwd(), 'public', cleanRel),
    path.join(process.cwd(), cleanRel),
    path.join(__dirname, '..', 'public', cleanRel),
    path.join(process.cwd(), 'autolib-student-web', 'public', cleanRel)
  ];

  let targetFile = null;
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        targetFile = c;
        break;
      }
    } catch (_) {}
  }

  if (!targetFile) {
    return send(res, 404, 'Not found');
  }

  try {
    const data = await fs.promises.readFile(targetFile);
    const ext = path.extname(targetFile).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    return send(res, 404, 'Not found');
  }
}

// ── Server Handler ──────────────────────────────────────────────────
async function appHandler(req, res) {
  try {
    securityHeaders(res);
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const url = new URL(req.url, `${proto}://${host}`);

    // Recover original route if rewritten by hosting platform (Vercel)
    const matchedPath = req.headers['x-matched-path'] || req.headers['x-forwarded-path'];
    if (matchedPath && (matchedPath.startsWith('/api') || matchedPath.startsWith('/healthz'))) {
      url.pathname = matchedPath.split('?')[0];
    } else if (url.searchParams.has('path')) {
      url.pathname = '/api/' + url.searchParams.get('path');
    }
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
    return await serveStatic(req, res, url);
  } catch (e) {
    if (e && e.status) return send(res, e.status, { error: e.message });
    console.error('[error]', e);
    const msg = e && e.message ? e.message : 'Something went wrong. Please try again.';
    if (!res.headersSent) return send(res, 500, { error: msg });
    res.end();
  }
}

const server = http.createServer(appHandler);

if (require.main === module || !process.env.VERCEL) {
  server.listen(PORT, () => console.log(`A.K.L.A.T. student portal listening on port ${PORT}`));
}

// Export appHandler for Vercel Serverless Function & server for Node
module.exports = appHandler;
module.exports.server = server;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (realtime) {
      try { realtime.close(); } catch { /* ignore */ }
    }
    server.close(() => pool.end().finally(() => process.exit(0)));
  });
}
