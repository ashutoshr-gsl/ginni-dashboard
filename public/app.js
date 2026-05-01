// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
let currentUser = null;
let storeList   = [];
let salesPage   = 1;
let editingUserId = null;

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  setDefaultDates();
  document.getElementById('login-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
  document.getElementById('login-user').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('login-pass').focus(); });

  // Check if already logged in
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      startApp(data.user);
    }
  } catch(e) {}
});

function setDefaultDates() {
  const today = new Date();
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
  const fmt = d => d.toISOString().slice(0,10);
  ['d-from','s-from'].forEach(id => { const el=document.getElementById(id); if(el) el.value=fmt(weekAgo); });
  ['d-to','s-to'].forEach(id => { const el=document.getElementById(id); if(el) el.value=fmt(today); });
}

// ═══════════════════════════════════════
// LOGIN / LOGOUT
// ═══════════════════════════════════════
async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-err');
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Login failed'; errEl.style.display = 'block'; return; }
    startApp(data.user);
  } catch(e) {
    errEl.textContent = 'Network error — please try again'; errEl.style.display = 'block';
  }
}

function startApp(user) {
  currentUser = user;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('user-av').textContent = user.name.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('settings-user').textContent = user.name + ' (' + user.role + ')';

  if (user.role === 'admin') {
    document.getElementById('nav-users').style.display = 'flex';
  }

  loadStoreList().then(() => {
    loadDashboard();
  });

  // Auto-refresh every 60 seconds
  setInterval(() => {
    loadDashboard();
    if (document.getElementById('view-sales').classList.contains('active')) loadSales(salesPage);
  }, 60000);
}

function confirmLogout() {
  if (confirm('Sign out?')) {
    fetch('/api/auth/logout', { method: 'POST' }).finally(() => location.reload());
  }
}

// ═══════════════════════════════════════
// STORE LIST
// ═══════════════════════════════════════
async function loadStoreList() {
  try {
    const res = await fetch('/api/zwing/store-list');
    if (!res.ok) return;
    const data = await res.json();
    storeList = Array.isArray(data) ? data : (data.data || []);
    populateStoreSelects();
  } catch(e) {}
}

function populateStoreSelects() {
  ['d-store','s-store'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">All Stores</option>';
    storeList.forEach(s => {
      const o = document.createElement('option');
      o.value = s.store_id || s.id;
      o.textContent = s.name || s.store_name || s.store_id;
      sel.appendChild(o);
    });
    if (prev) sel.value = prev;
  });
}

// ═══════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════
async function loadDashboard() {
  const from  = document.getElementById('d-from').value;
  const to    = document.getElementById('d-to').value;
  const store = document.getElementById('d-store').value;

  setCardsLoading();
  document.getElementById('d-err').style.display = 'none';

  try {
    const params = new URLSearchParams({ from_date: from, to_date: to, filtered_store: store ? '['+store+']' : '[]' });
    const res = await fetch('/api/zwing/dashboard-data?' + params);
    const data = await res.json();

    if (!res.ok) {
      showDashErr(data.error);
      return;
    }

    renderCards(data.data || []);
    document.getElementById('live-badge').style.display = 'flex';
  } catch(e) {
    showDashErr('Network error — ' + e.message);
  }
}

function setCardsLoading() {
  const labels = ['Total Sales','Net Sale','Total Return','Avg Bill','Transactions','Avg Items','Discount','Total Tax'];
  document.getElementById('cards-grid').innerHTML = labels.map(l =>
    `<div class="mcard"><div class="mcard-lbl">${l}</div><div class="mcard-val skeleton"></div><div class="mcard-sub"></div></div>`
  ).join('');
}

function renderCards(rows) {
  const totalSales = rows.reduce((s,r) => s + parseFloat(r.total||0), 0);
  const totalSub   = rows.reduce((s,r) => s + parseFloat(r.subtotal||0), 0);
  const totalTax   = rows.reduce((s,r) => s + parseFloat(r.tax||0), 0);
  const totalQty   = rows.reduce((s,r) => s + parseInt(r.total_qty||0), 0);
  const totalDisc  = rows.reduce((s,r) =>
    s + parseFloat(r.item_level_promo||0) + parseFloat(r.item_level_manual_discount||0)
      + parseFloat(r.bill_discount||0) + parseFloat(r.bill_level_manual_discount||0), 0);
  const returns    = rows.reduce((s,r) => s + Math.max(0, parseFloat(r.subtotal||0) - parseFloat(r.total||0)), 0);
  const bills      = rows.length;
  const avgBill    = bills > 0 ? totalSales/bills : 0;
  const avgSize    = bills > 0 ? totalQty/bills : 0;
  const netSale    = totalSales - returns;
  const fmt = n => '₹\u00A0' + Math.round(n).toLocaleString('en-IN');

  const cards = [
    { lbl:'Total Sales',  val: fmt(totalSales), sub: bills+' bills' },
    { lbl:'Net Sale',     val: fmt(netSale),    sub: bills+' transactions' },
    { lbl:'Total Return', val: fmt(returns),    sub: rows.filter(r=>parseFloat(r.subtotal)>parseFloat(r.total)).length+' returns' },
    { lbl:'Avg Bill',     val: fmt(avgBill),    sub: bills+' bills' },
    { lbl:'Transactions', val: bills,           sub: 'total invoices' },
    { lbl:'Avg Items',    val: avgSize.toFixed(2), sub: 'items per bill' },
    { lbl:'Discount',     val: fmt(totalDisc),  sub: totalSub>0 ? (totalDisc/totalSub*100).toFixed(1)+'% of subtotal' : '—' },
    { lbl:'Total Tax',    val: fmt(totalTax),   sub: 'GST collected' },
  ];

  document.getElementById('cards-grid').innerHTML = cards.map(c =>
    `<div class="mcard"><div class="mcard-lbl">${c.lbl}</div><div class="mcard-val">${c.val}</div><div class="mcard-sub">${c.sub}</div></div>`
  ).join('');
}

function showDashErr(msg) {
  const el = document.getElementById('d-err');
  el.innerHTML = msg === 'ZWING_AUTH_EXPIRED'
    ? 'Zwing session expired. Go to <strong>Settings</strong> and update the cookie.'
    : !msg || msg.includes('cookie') || msg.includes('credentials')
    ? 'Zwing not connected. Go to <strong>Settings</strong> to paste your cookie.'
    : '⚠ ' + msg;
  el.style.display = 'block';
  setCardsLoading();
}

// ═══════════════════════════════════════
// SALES REPORT
// ═══════════════════════════════════════
async function loadSales(page = 1) {
  salesPage = page;
  const from  = document.getElementById('s-from').value;
  const to    = document.getElementById('s-to').value;
  const store = document.getElementById('s-store').value;

  document.getElementById('s-meta').textContent = 'Loading…';
  document.getElementById('txn-list').innerHTML = '<div style="padding:32px;text-align:center;color:#888;font-size:13px">Loading…</div>';
  document.getElementById('s-err').style.display = 'none';

  try {
    const params = new URLSearchParams({ page, from_date: from, to_date: to, filtered_store: store ? '['+store+']' : '[]' });
    const res = await fetch('/api/zwing/sales-report?' + params);
    const data = await res.json();

    if (!res.ok) {
      document.getElementById('s-err').textContent = data.error === 'ZWING_AUTH_EXPIRED'
        ? 'Session expired — update cookie in Settings' : '⚠ ' + data.error;
      document.getElementById('s-err').style.display = 'block';
      document.getElementById('txn-list').innerHTML = '';
      document.getElementById('s-meta').textContent = '';
      return;
    }

    const rows = data.data?.data || [];
    const pag  = data.pagination || data.data || {};
    renderTxnList(rows, pag);
  } catch(e) {
    document.getElementById('s-err').textContent = 'Network error';
    document.getElementById('s-err').style.display = 'block';
    document.getElementById('s-meta').textContent = '';
  }
}

function renderTxnList(rows, pag) {
  const total    = pag.total || rows.length;
  const lastPage = pag.last_page || 1;
  const from     = pag.from || 1;
  const to       = pag.to || rows.length;

  document.getElementById('s-meta').textContent = total + ' records';

  if (!rows.length) {
    document.getElementById('txn-list').innerHTML = '<div style="padding:32px;text-align:center;color:#888;font-size:13px">No records found</div>';
    document.getElementById('s-pag-info').textContent = '';
    document.getElementById('s-pag-btns').innerHTML = '';
    return;
  }

  document.getElementById('txn-list').innerHTML = rows.map((r, i) => {
    const disc = parseFloat(r.item_level_promo||0) + parseFloat(r.item_level_manual_discount||0)
               + parseFloat(r.bill_discount||0) + parseFloat(r.bill_level_manual_discount||0);
    return `<div class="txn-card">
      <div class="txn-top">
        <div>
          <div class="txn-invoice">${r.invoice_id}</div>
          <div class="txn-store">${r.name}</div>
        </div>
        <div class="txn-amount">₹${parseFloat(r.total).toLocaleString('en-IN')}</div>
      </div>
      <div class="txn-row"><span>Customer</span><span>${r.customer_name||'—'}</span></div>
      <div class="txn-row"><span>Date & Time</span><span>${r.date} ${r.invoice_time||''}</span></div>
      <div class="txn-row"><span>Qty</span><span>${r.total_qty} items</span></div>
      <div class="txn-row"><span>Subtotal</span><span>₹${parseFloat(r.subtotal).toLocaleString('en-IN')}</span></div>
      ${disc > 0 ? `<div class="txn-row"><span>Discount</span><span class="disc-val">-₹${disc.toLocaleString('en-IN')}</span></div>` : ''}
      <div class="txn-row" style="margin-top:6px"><span><span class="txn-method">${r.method||'—'}</span></span><span style="color:#888;font-size:11px">${r.City||r.location||''}</span></div>
    </div>`;
  }).join('');

  document.getElementById('s-pag-info').textContent = `${from}–${to} of ${total}`;
  renderPagination(salesPage, lastPage);
}

function renderPagination(cur, last) {
  const wrap = document.getElementById('s-pag-btns');
  wrap.innerHTML = '';
  const btn = (lbl, pg, active=false, dis=false) => {
    const b = document.createElement('button');
    b.className = 'pag-btn' + (active?' cur':'');
    b.textContent = lbl; b.disabled = dis;
    b.onclick = () => loadSales(pg);
    wrap.appendChild(b);
  };
  btn('← Prev', cur-1, false, cur<=1);
  btn('Next →', cur+1, false, cur>=last);
}

// ═══════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════
async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    const users = await res.json();
    renderUsersList(users);
  } catch(e) {}
}

function renderUsersList(users) {
  const el = document.getElementById('users-list');
  if (!users.length) { el.innerHTML = '<div style="text-align:center;color:#888;padding:32px;font-size:13px">No users yet</div>'; return; }
  el.innerHTML = users.map(u => `
    <div class="user-card">
      <div class="user-top">
        <div class="user-av">${u.name.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase()}</div>
        <div style="flex:1">
          <div class="user-name">${u.name} <span class="role-badge role-${u.role}">${u.role}</span></div>
          <div class="user-un">${u.username}</div>
        </div>
      </div>
      <div class="user-stores">
        ${u.role==='admin' ? 'All stores' : u.stores?.length ? u.stores.slice(0,4).join(', ')+(u.stores.length>4?` +${u.stores.length-4} more`:'') : 'No stores assigned'}
      </div>
      <div class="user-actions">
        <button class="btn-edit" onclick="openUserDrawer(${u.id})">Edit</button>
        ${u.id !== 1 ? `<button class="btn-del" onclick="deleteUser(${u.id})">Delete</button>` : ''}
      </div>
    </div>`).join('');
}

function openUserDrawer(id = null) {
  editingUserId = id;
  const users = [];
  document.getElementById('drawer-title').textContent = id ? 'Edit User' : 'Add User';
  document.getElementById('pw-label').textContent = id ? 'New Password (leave blank to keep)' : 'Password';
  document.getElementById('drawer-err').style.display = 'none';
  document.getElementById('u-name').value = '';
  document.getElementById('u-username').value = '';
  document.getElementById('u-pw').value = '';
  document.getElementById('u-role').value = 'manager';

  // Populate store checkboxes
  const grid = document.getElementById('stores-check');
  grid.innerHTML = storeList.map(s => {
    const sid = String(s.store_id||s.id);
    const nm  = s.name||s.store_name||sid;
    return `<label class="store-item"><input type="checkbox" value="${sid}" onchange="updateStoreCount()"><span>${nm}</span></label>`;
  }).join('') || '<div style="padding:12px;font-size:13px;color:#888">No stores loaded yet</div>';

  if (id) {
    fetch('/api/users').then(r=>r.json()).then(users => {
      const u = users.find(x=>x.id===id);
      if (u) {
        document.getElementById('u-name').value = u.name;
        document.getElementById('u-username').value = u.username;
        document.getElementById('u-role').value = u.role;
        if (u.stores) {
          document.querySelectorAll('#stores-check input').forEach(cb => {
            cb.checked = u.stores.includes(cb.value);
          });
        }
        toggleStoresField();
        updateStoreCount();
      }
    });
  }

  toggleStoresField();
  updateStoreCount();
  document.getElementById('user-drawer').classList.add('open');
}

function closeDrawer() { document.getElementById('user-drawer').classList.remove('open'); }

function toggleStoresField() {
  document.getElementById('stores-field').style.display =
    document.getElementById('u-role').value === 'admin' ? 'none' : 'block';
}

function updateStoreCount() {
  document.getElementById('store-count').textContent =
    document.querySelectorAll('#stores-check input:checked').length;
}

async function saveUser() {
  const name     = document.getElementById('u-name').value.trim();
  const username = document.getElementById('u-username').value.trim();
  const password = document.getElementById('u-pw').value;
  const role     = document.getElementById('u-role').value;
  const stores   = role === 'admin' ? [] :
    [...document.querySelectorAll('#stores-check input:checked')].map(c => c.value);
  const errEl    = document.getElementById('drawer-err');

  if (!name || !username) { errEl.textContent='Name and username required'; errEl.style.display='block'; return; }
  if (!editingUserId && !password) { errEl.textContent='Password required for new users'; errEl.style.display='block'; return; }

  try {
    const url = editingUserId ? `/api/users/${editingUserId}` : '/api/users';
    const method = editingUserId ? 'PUT' : 'POST';
    const body = { name, username, role, stores, ...(password ? {password} : {}) };
    const res = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.style.display='block'; return; }
    closeDrawer();
    loadUsers();
  } catch(e) {
    errEl.textContent = 'Error saving user'; errEl.style.display='block';
  }
}

async function deleteUser(id) {
  if (!confirm('Delete this user?')) return;
  await fetch(`/api/users/${id}`, { method: 'DELETE' });
  loadUsers();
}

// ═══════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════
async function saveZwingCreds() {
  const cookies = document.getElementById('zwing-cookies').value.trim();
  const xsrf    = document.getElementById('zwing-xsrf').value.trim();
  const statusEl = document.getElementById('conn-status');

  if (!cookies || !xsrf) { statusEl.className='conn-status conn-fail'; statusEl.textContent='Please fill both fields'; return; }
  statusEl.className='conn-status'; statusEl.textContent='Saving & testing…';

  try {
    const res = await fetch('/api/admin/zwing-credentials', {
      method: 'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ cookies, xsrf })
    });
    if (!res.ok) throw new Error('Save failed');

    // Test connection
    const test = await fetch('/api/admin/zwing-status');
    const data = await test.json();
    if (data.connected) {
      statusEl.className='conn-status conn-ok';
      statusEl.textContent='✓ Connected to Zwing — data will now load for all users';
      loadStoreList().then(() => loadDashboard());
    } else {
      statusEl.className='conn-status conn-fail';
      statusEl.textContent='✗ Could not connect: ' + (data.error || 'Check cookie values');
    }
  } catch(e) {
    statusEl.className='conn-status conn-fail'; statusEl.textContent='Error: ' + e.message;
  }
}

// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════
function switchView(name, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  btn.classList.add('active');
  const titles = { dashboard:'Dashboard', sales:'Sales Report', users:'Users', settings:'Settings' };
  document.getElementById('topbar-title').textContent = titles[name] || name;
  document.getElementById('content').scrollTop = 0;

  if (name === 'sales') loadSales(1);
  if (name === 'users') loadUsers();
}
