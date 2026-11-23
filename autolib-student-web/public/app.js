(() => {
  'use strict';

  // -- Tiny helpers --
  const app = document.getElementById('app');

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(path, body) {
    const res = await fetch('/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const fmtDate = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric' });
  const fmtDateTime = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  function initials(name) {
    const p = String(name || '').trim().split(/[,\s]+/).filter(Boolean);
    if (!p.length) return '?';
    return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }

  function typeBadge(type) {
    const map = { BORROWED: ['b-blue', 'Borrowed'], RETURNED: ['b-green', 'Returned'], OVERDUE: ['b-red', 'Overdue'] };
    const [cls, label] = map[type] || ['b-gray', type];
    return h('span', { class: 'badge ' + cls }, label);
  }

  function dueInfo(borrowedAt, loanDays) {
    const b = new Date(borrowedAt);
    const due = new Date(b.getFullYear(), b.getMonth(), b.getDate() + loanDays);
    const t = new Date();
    const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    return { due, days: Math.round((due - today) / 86400000) };
  }

  function dueBadge(days) {
    if (days < 0) return h('span', { class: 'badge b-red' }, 'Overdue by ' + (-days) + (days === -1 ? ' day' : ' days'));
    if (days === 0) return h('span', { class: 'badge b-amber' }, 'Due today');
    if (days <= 2) return h('span', { class: 'badge b-amber' }, 'Due in ' + days + (days === 1 ? ' day' : ' days'));
    return h('span', { class: 'badge b-blue' }, 'Due in ' + days + ' days');
  }

  // -- State --
  let me = null;
  let rules = { maxLoans: 5, loanDays: 7, penaltyPerDay: 5 };
  let view = 'dashboard';
  let mainEl = null;
  let titleEl = null;
  let navButtons = {};

  const VIEWS = {
    dashboard: ['Dashboard', renderDashboard],
    catalog: ['Find Books', renderCatalog],
    history: ['My History', renderHistory],
    profile: ['My Profile', renderProfile],
  };

  // -- Auth screen (login / activate / forgot password) --
  function showAuth(mode = 'login', notice = '') {
    const msg = h('div', { class: 'msg err hidden', role: 'alert' });
    const okMsg = notice ? h('div', { class: 'msg ok' }, notice) : null;

    const id = h('input', { id: 'sid', type: 'text', autocomplete: 'username', placeholder: 'e.g. 25-10834', required: true });
    const pw = h('input', { id: 'pw', type: 'password',
      autocomplete: mode === 'login' ? 'current-password' : 'new-password',
      required: true, minlength: mode === 'login' ? null : '8' });
    const name = h('input', { id: 'nm', type: 'text', autocomplete: 'name', placeholder: 'Last name, First name M.' });

    const btnLabel = mode === 'login' ? 'Sign in'
      : mode === 'forgot' ? 'Reset my password'
      : 'Activate my account';
    const btn = h('button', { class: 'btn block', type: 'submit' }, btnLabel);

    const needsName = mode === 'activate' || mode === 'forgot';
    const pwLabel = mode === 'login' ? 'Password'
      : mode === 'forgot' ? 'New password (8+ characters)'
      : 'Create a password (8+ characters)';

    const form = h('form', { novalidate: true },
      okMsg, msg,
      h('label', { class: 'field' }, h('span', null, 'Student ID'), id),
      needsName ? h('label', { class: 'field' }, h('span', null, 'Full name (as registered at the library)'), name) : null,
      h('label', { class: 'field' }, h('span', null, pwLabel), pw),
      mode === 'activate'
        ? h('p', { class: 'hint' }, 'First time here? Your name must match the library record. You only need to do this once.')
        : null,
      mode === 'forgot'
        ? h('p', { class: 'hint' }, 'Enter your Student ID and full name exactly as the library has them, then set a new password.')
        : null,
      mode === 'login'
        ? h('p', { class: 'hint', style: 'margin-top:4px;text-align:right;' },
            h('a', { href: '#', style: 'color:var(--red);font-weight:700;text-decoration:none;',
              onclick: (e) => { e.preventDefault(); showAuth('forgot'); } }, 'Forgot password?'))
        : null,
      btn);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.classList.add('hidden');
      if (!id.value.trim() || !pw.value || (needsName && !name.value.trim())) {
        msg.textContent = 'Please fill in all fields.';
        msg.classList.remove('hidden');
        return;
      }
      btn.disabled = true;
      try {
        if (mode === 'login') {
          await api('/login', { studentId: id.value.trim(), password: pw.value });
        } else if (mode === 'activate') {
          await api('/activate', { studentId: id.value.trim(), name: name.value, password: pw.value });
        } else if (mode === 'forgot') {
          await api('/reset-password', { studentId: id.value.trim(), name: name.value, password: pw.value });
        }
        await boot();
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.remove('hidden');
        btn.disabled = false;
      }
    });

    const tab = (m, label) => h('button', { type: 'button', class: mode === m ? 'on' : '', onclick: () => showAuth(m) }, label);

    app.replaceChildren(h('div', { class: 'auth-wrap' },
      h('div', { class: 'auth-card' },
        h('div', { class: 'auth-logo' },
          h('img', { src: '/logo.png', alt: '' }),
          h('div', null, h('b', null, 'A.K.L.A.T.'), h('span', null, 'Student Portal - Library'))),
        h('div', { class: 'tabs' },
          tab('login', 'Sign in'),
          tab('activate', 'First time? Activate'),
          tab('forgot', 'Forgot password?')),
        form)));
    id.focus();
  }

  // -- Shell --
  function showShell() {
    navButtons = {};
    const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
      Object.entries(VIEWS).map(([key, [label]]) => {
        const b = h('button', { type: 'button', onclick: () => go(key) }, label);
        navButtons[key] = b;
        return b;
      }));

    const userInitials = initials(me.name);

    const side = h('aside', { class: 'side' },
      h('div', { class: 'brand' },
        h('img', { src: '/logo.png', alt: '' }),
        h('div', null, h('b', null, 'A.K.L.A.T.'), h('span', null, 'STUDENT PORTAL'))),
      nav,
      h('div', { class: 'status-indicator' },
        h('span', { class: 'dot-green' }),
        'Neon Postgres Active'),
      h('div', { class: 'who' },
        h('div', { class: 'who-avatar' }, userInitials),
        h('div', { class: 'meta' },
          h('div', { class: 'nm' }, me.name),
          h('div', { class: 'wid' }, me.studentId)),
        h('button', { type: 'button', class: 'btn-signout', onclick: logout }, 'Sign out')));

    titleEl = h('div', { class: 'top' }, '');
    mainEl = h('div', { class: 'content' });
    app.replaceChildren(h('div', { class: 'shell' }, side, h('main', { class: 'main' }, titleEl, mainEl)));
    go(view);
  }

  async function go(key) {
    view = key;
    const [title, render] = VIEWS[key];
    titleEl.textContent = title;
    for (const [k, b] of Object.entries(navButtons)) b.classList.toggle('on', k === key);
    mainEl.replaceChildren(h('div', { class: 'loading' }, 'Loading...'));
    try {
      const node = await render();
      mainEl.replaceChildren(...(Array.isArray(node) ? node : [node]));
    } catch (err) {
      if (err.status === 401) return showAuth('login', '');
      mainEl.replaceChildren(h('div', { class: 'msg err' }, err.message));
    }
  }

  async function logout() {
    try { await api('/logout', {}); } catch { /* ignore */ }
    me = null;
    showAuth('login');
  }

  // -- Dashboard --
  async function renderDashboard() {
    const [meRes, loansRes, histRes] = await Promise.all([api('/me'), api('/loans'), api('/history?limit=5')]);
    me = meRes.student; rules = meRes.rules;
    const loans = loansRes.loans;

    let next = null;
    for (const l of loans) {
      const d = dueInfo(l.borrowedAt, rules.loanDays);
      if (!next || d.days < next.days) next = d;
    }
    const remaining = Math.max(0, rules.maxLoans - me.activeLoans);

    const stat = (lbl, num, sub, cls) => h('div', { class: 'card stat' },
      h('div', { class: 'lbl' }, lbl), h('div', { class: 'num ' + cls }, num), h('div', { class: 'sub ' + cls }, sub));

    const stats = h('div', { class: 'stats' },
      stat('Active Loans', me.activeLoans, me.activeLoans ? 'Books in your possession' : 'No active loans', 'c-blue'),
      stat('Overdue', me.overdueCount, me.overdueCount ? 'Please return ASAP' : 'All good!', me.overdueCount ? 'c-red' : 'c-green'),
      stat('Remaining Slots', remaining, 'Max ' + rules.maxLoans + ' at a time', 'c-muted'),
      next
        ? stat('Next Due', fmtDate.format(next.due), next.days < 0 ? 'Overdue' : next.days === 0 ? 'Due today' : 'In ' + next.days + (next.days === 1 ? ' day' : ' days'), next.days < 0 ? 'c-red' : next.days <= 2 ? 'c-amber' : 'c-green')
        : stat('Next Due', '--', 'No pending returns', 'c-muted'));

    const loanList = loans.length
      ? loans.map((l) => {
          const d = dueInfo(l.borrowedAt, rules.loanDays);
          return h('div', { class: 'row' + (d.days < 0 ? ' over' : '') },
            h('div', { class: 'grow' }, h('div', { class: 't' }, l.title), h('div', { class: 's' }, 'Due ' + fmtDate.format(d.due) + ' - ' + l.barcode)),
            dueBadge(d.days));
        })
      : h('div', { class: 'empty' }, 'No books currently borrowed.');

    const recent = histRes.history.length
      ? histRes.history.map((x) => h('div', { class: 'log' },
          h('div', { class: 'grow' }, h('div', { class: 't' }, x.title), h('div', { class: 's c-muted' }, fmtDateTime.format(new Date(x.at)))),
          typeBadge(x.type)))
      : h('div', { class: 'empty' }, 'No recent activity.');

    return [
      stats,
      h('div', { class: 'two' },
        h('div', { class: 'card' }, h('h3', null, 'My Borrowed Books'), loanList),
        h('div', { class: 'card' }, h('h3', null, 'Recent Activity'), recent)),
      h('div', { class: 'notice' }, 'To borrow or return a book, please visit the library counter. You can search the catalog under "Find Books".'),
    ];
  }

  // -- Catalog --
  async function renderCatalog() {
    const { sections } = await api('/sections');
    const q = h('input', { type: 'search', placeholder: 'Search by title, author, call number or ISBN...', 'aria-label': 'Search books' });
    const sec = h('select', { 'aria-label': 'Section' }, h('option', { value: '' }, 'All sections'), sections.map((s) => h('option', { value: s }, s)));
    const avail = h('input', { type: 'checkbox' });
    const out = h('div', null);
    const count = h('div', { class: 'count' });
    let timer = null, seq = 0;

    async function run() {
      const my = ++seq;
      const params = new URLSearchParams({ q: q.value.trim(), section: sec.value, available: avail.checked ? '1' : '0' });
      try {
        const { books } = await api('/books?' + params);
        if (my !== seq) return;
        count.textContent = books.length + ' book' + (books.length === 1 ? '' : 's') + ' found' + (books.length === 60 ? ' (showing first 60 - refine your search)' : '');
        if (!books.length) { out.replaceChildren(h('div', { class: 'empty' }, 'No books match your search.')); return; }
        out.replaceChildren(h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['TITLE', 'AUTHOR', 'SECTION', 'CALL NO.', 'AVAILABLE'].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'hide-sm' : '' }, t)))),
          h('tbody', null, books.map((b) => h('tr', null,
            h('td', null, h('strong', null, b.title)),
            h('td', null, b.author),
            h('td', { class: 'hide-sm' }, b.section),
            h('td', { class: 'hide-sm mono' }, b.callNumber || '--'),
            h('td', null, h('span', { class: 'badge ' + (b.available > 0 ? 'b-green' : 'b-red') }, b.available > 0 ? b.available + '/' + b.total + ' available' : 'All out'))))))));
      } catch (err) {
        if (my !== seq) return;
        if (err.status === 401) return showAuth('login');
        out.replaceChildren(h('div', { class: 'msg err' }, err.message));
      }
    }

    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
    sec.addEventListener('change', run);
    avail.addEventListener('change', run);
    run();

    return h('div', { class: 'card' },
      h('div', { class: 'tools' },
        h('div', { class: 'grow' }, q),
        h('div', null, sec),
        h('label', { class: 'chk' }, avail, 'Available only')),
      out, count);
  }

  // -- History --
  async function renderHistory() {
    const { history } = await api('/history?limit=200');
    if (!history.length) return h('div', { class: 'card' }, h('h3', null, 'Transaction History'), h('div', { class: 'empty' }, 'No transactions yet.'));
    return h('div', { class: 'card' }, h('h3', null, 'Transaction History'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['DATE & TIME', 'BOOK', 'BARCODE', 'TYPE'].map((t, i) => h('th', { class: i === 2 ? 'hide-sm' : '' }, t)))),
        h('tbody', null, history.map((x) => h('tr', null,
          h('td', null, fmtDateTime.format(new Date(x.at))),
          h('td', null, h('strong', null, x.title)),
          h('td', { class: 'hide-sm mono' }, x.barcode),
          h('td', null, typeBadge(x.type), x.type === 'OVERDUE' && x.daysOverdue ? h('span', { class: 'mono' }, ' ' + x.daysOverdue + 'd') : null)))))),
      h('div', { class: 'count' }, 'Showing your latest ' + history.length + ' transaction' + (history.length === 1 ? '' : 's') + '.'));
  }

  // -- Profile --
  async function renderProfile() {
    const res = await api('/me');
    me = res.student; rules = res.rules;
    const pct = Math.min(100, Math.round((me.activeLoans / rules.maxLoans) * 100));
    const bar = h('i', null);
    bar.style.width = pct + '%';
    const kv = (k, v) => h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    return [
      h('div', { class: 'card prof' },
        h('div', { class: 'avatar' }, initials(me.name)),
        h('div', null, h('h2', null, me.name), h('div', { class: 'mono' }, me.studentId),
          h('div', { class: 'badges' },
            h('span', { class: 'badge b-blue' }, me.department),
            h('span', { class: 'badge b-gray' }, me.year),
            h('span', { class: 'badge ' + (me.nfcRegistered ? 'b-green' : 'b-amber') }, me.nfcRegistered ? 'NFC registered' : 'NFC not registered')))),
      h('div', { class: 'card' }, h('h3', null, 'Account Details'),
        h('div', { class: 'grid2' },
          kv('Student ID', me.studentId), kv('Department', me.department),
          kv('Year Level', me.year), kv('NFC Status', me.nfcRegistered ? 'Registered' : 'Not registered'),
          kv('Active Loans', me.activeLoans + ' of ' + rules.maxLoans), kv('Overdue Books', String(me.overdueCount))),
        h('div', { class: 'bar', role: 'img', 'aria-label': 'Loan slots used' }, bar)),
      h('div', { class: 'card' }, h('h3', null, 'Borrowing Rules'),
        h('ul', { class: 'rules' },
          h('li', null, 'Maximum ' + rules.maxLoans + ' books at a time'),
          h('li', null, 'Loan period: ' + rules.loanDays + ' days'),
          h('li', null, 'Renewal allowed once (additional ' + rules.loanDays + ' days)'),
          h('li', null, 'Overdue penalty: P' + rules.penaltyPerDay.toFixed(2) + ' per day'),
          h('li', null, 'Lost book: full replacement cost + P50.00 processing fee'))),
    ];
  }

  // -- Boot --
  async function boot() {
    try {
      const res = await api('/me');
      me = res.student; rules = res.rules;
      showShell();
    } catch (err) {
      showAuth('login');
    }
  }

  boot();
})();
