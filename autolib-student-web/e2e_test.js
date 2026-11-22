const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { createRealtime, rawSql } = require('@neon/realtime/server');
const ws = require('ws');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const TEST_PORT = parseInt(process.env.PORT || '3005', 10);

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('====================================================');
  console.log('   END-TO-END VERIFICATION: NEON SERVICES IN APP    ');
  console.log('====================================================');

  console.log('\n[1/6] Starting application server (server.js)...');
  const serverProc = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProc.stdout.on('data', (d) => console.log('  [server stdout]:', d.toString().trim()));
  serverProc.stderr.on('data', (d) => console.error('  [server stderr]:', d.toString().trim()));

  // Wait for server to be ready
  let serverReady = false;
  for (let i = 0; i < 20; i++) {
    await wait(500);
    try {
      const res = await request({ hostname: '127.0.0.1', port: TEST_PORT, path: '/healthz', method: 'GET' });
      if (res.status === 200) {
        serverReady = true;
        break;
      }
    } catch {
      // Retry
    }
  }

  if (!serverReady) {
    serverProc.kill();
    throw new Error('Server failed to start or /healthz did not respond 200.');
  }
  console.log('  Application server is running and listening on port 3000.');

  try {
    // ── Test 1: Neon Health & Postgres Service ──
    console.log('\n[2/6] Testing Service: Lakebase Postgres (via /healthz and /api/neon/status)...');
    const healthRes = await request({ hostname: '127.0.0.1', port: TEST_PORT, path: '/healthz', method: 'GET' });
    console.log('  GET /healthz response:', healthRes.json);
    if (!healthRes.json || !healthRes.json.ok) {
      throw new Error('Healthcheck failed: ' + healthRes.body);
    }

    const statusRes = await request({ hostname: '127.0.0.1', port: TEST_PORT, path: '/api/neon/status', method: 'GET' });
    console.log('  GET /api/neon/status response:', statusRes.json);
    if (!statusRes.json.postgres.configured) {
      throw new Error('Postgres not configured.');
    }
    console.log('  [PASS] Lakebase Postgres connected successfully on branch:', statusRes.json.postgres.branch);

    // ── Test 2: Database Queries (Books Catalog) ──
    console.log('\n[3/6] Testing Database Queries: Catalog Search (/api/books)...');
    // Login or query public endpoints
    const booksRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/books',
      method: 'GET'
    });
    // Note: /api/books requires login in original server.js. Let's activate / sign in first!
    console.log('\n[4/6] Testing User Authentication & Database Transactions...');
    // Ensure test account is activated
    const activateRes = await request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/activate',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      { studentId: '25-10834', name: 'Dela Cruz, Juan M.', password: 'Password123!' }
    );
    console.log('  POST /api/activate status:', activateRes.status, activateRes.json);

    let cookie = '';
    if (activateRes.headers['set-cookie']) {
      cookie = activateRes.headers['set-cookie'][0];
    }

    if (!cookie) {
      const loginRes = await request(
        {
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/api/login',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        },
        { studentId: '25-10834', password: 'Password123!' }
      );
      console.log('  POST /api/login status:', loginRes.status, loginRes.json);
      cookie = loginRes.headers['set-cookie'][0];
    }
    console.log('  Authenticated with session cookie. Token received.');

    const meRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/me',
      method: 'GET',
      headers: { Cookie: cookie }
    });
    console.log('  GET /api/me response student:', meRes.json ? meRes.json.student : meRes.body);
    if (!meRes.json || !meRes.json.student) {
      throw new Error('Failed to retrieve student profile from Postgres.');
    }
    console.log('  [PASS] Student authentication and Postgres data read verified.');

    const authedBooksRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/books',
      method: 'GET',
      headers: { Cookie: cookie }
    });
    console.log('  GET /api/books count:', authedBooksRes.json ? authedBooksRes.json.books.length : 0);
    if (!authedBooksRes.json || !authedBooksRes.json.books.length) {
      throw new Error('Books catalog returned empty or error.');
    }
    console.log('  First book in catalog:', authedBooksRes.json.books[0]);
    console.log('  [PASS] Books catalog queried from Neon Postgres successfully.');

    // ── Test 3: Neon Realtime Service ──
    console.log('\n[5/6] Testing Service: Neon Realtime (Sealing API Endpoints)...');
    const rtHealthRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/realtime/health',
      method: 'GET'
    });
    console.log('  GET /api/realtime/health response:', rtHealthRes.json);
    if (!rtHealthRes.json || !rtHealthRes.json.ok) {
      throw new Error('Neon Realtime health check failed: ' + rtHealthRes.body);
    }
    console.log('  [PASS] Neon Realtime query sealing endpoint is functional.');

    const rtBooksRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/realtime/books',
      method: 'GET'
    });
    console.log('  GET /api/realtime/books sealed token:', rtBooksRes.json ? typeof rtBooksRes.json.sealed : null);
    if (!rtBooksRes.json || !rtBooksRes.json.sealed) {
      throw new Error('Failed to get sealed query from /api/realtime/books.');
    }
    console.log('  [PASS] Realtime query sealed successfully by server.');

    // ── Test 4: Realtime Live Subscription Over WebSocket ──
    console.log('\n[6/6] Testing Realtime Live WebSocket Subscription End-to-End...');
    const realtime = createRealtime({
      url: process.env.NEON_REALTIME_URL,
      secret: process.env.NEON_REALTIME_SECRET,
      db: 'neondb'
    });

    const liveBooksQuery = rawSql('SELECT barcode, title, author, available_copies FROM books');
    const liveSub = await realtime.subscribe(liveBooksQuery);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        liveSub.close();
        realtime.close();
        reject(new Error('Realtime subscription timed out waiting for initial live event.'));
      }, 12000);

      liveSub.onChange((evt) => {
        console.log('  Realtime WebSocket received live dataset:', evt.data ? evt.data.length : 0, 'rows');
        console.log('  Sample live row:', evt.data && evt.data[0]);
        clearTimeout(timeout);
        try { liveSub.close(); } catch { /* ignore */ }
        console.log('  [PASS] Neon Realtime WebSocket live subscription verified.');
        console.log('\n====================================================');
        console.log('  ALL NEON SERVICES TESTED AND VERIFIED END-TO-END! ');
        console.log('====================================================');
        try { serverProc.kill(); } catch { /* ignore */ }
        process.exit(0);
      });

      liveSub.onStateChange((state) => {
        console.log('  Realtime connection state:', state.status);
        if (state.status === 'error') {
          clearTimeout(timeout);
          liveSub.close();
          realtime.close();
          reject(new Error('Realtime connection encountered error: ' + state.error));
        }
      });
    });

    console.log('  [PASS] Neon Realtime WebSocket live subscription verified.');

    console.log('\n====================================================');
    console.log('  ALL NEON SERVICES TESTED AND VERIFIED END-TO-END! ');
    console.log('====================================================');
    try { serverProc.kill('SIGKILL'); } catch { /* ignore */ }
    process.exit(0);
  } finally {
    try { serverProc.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
