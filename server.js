const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── DATA STORE (file-based, no DB needed) ───────────────────────────────────
const DATA_FILE = path.join(__dirname, 'users.json');

function readUsers() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  // Default admin user
  const defaultUsers = [{
    id: 1,
    name: 'PM Admin',
    username: 'admin',
    password: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'Admin@123', 10),
    role: 'admin',
    stores: []
  }];
  writeUsers(defaultUsers);
  return defaultUsers;
}

function writeUsers(users) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

// ─── ZWING SESSION STORE ────────────────────────────────────────────────────
let zwingCookies = process.env.ZWING_COOKIES || '';
let zwingXsrf    = process.env.ZWING_XSRF    || '';
const ZWING_REPORT_BASE = 'https://lc.gozwing.com/api/v1/report';
const ZWING_ADMIN_BASE  = 'https://lc.gozwing.com/admin';

async function zwingFetch(apiPath, params = {}) {
  // store-list and filter endpoints live under /admin/, report endpoints under /api/v1/report/
  const adminPaths = ['/store-list', '/Statelist', '/get-settings', '/listing-filter'];
  const base = adminPaths.some(p => apiPath.startsWith(p)) ? ZWING_ADMIN_BASE : ZWING_REPORT_BASE;
  const url = new URL(base + apiPath);
  Object.entries(params).forEach(([k,v]) => { if(v !== undefined && v !== '') url.searchParams.set(k, v); });

  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': zwingXsrf,
      'Cookie': zwingCookies,
      'Referer': 'https://lc.gozwing.com/admin/report/sales',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (res.status === 401 || res.status === 403) throw new Error('ZWING_AUTH_EXPIRED');
  if (!res.ok) throw new Error(`ZWING_ERROR_${res.status}`);
  return res.json();
}

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ginni-dashboard-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.user = { id: user.id, name: user.name, username: user.username, role: user.role, stores: user.stores };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// ─── ZWING PROXY ROUTES ───────────────────────────────────────────────────────
app.get('/api/zwing/sales-report', requireAuth, async (req, res) => {
  try {
    const { page = 1, from_date, to_date, filtered_store = '[]' } = req.query;

    // Filter stores based on user role
    const user = req.session.user;
    let storeParam = filtered_store;
    if (user.role !== 'admin' && user.stores && user.stores.length > 0) {
      // Intersect requested stores with user's allowed stores
      let requested = [];
      try { requested = JSON.parse(filtered_store); } catch(e) {}
      const allowed = user.stores;
      const intersect = requested.length > 0
        ? requested.filter(s => allowed.includes(String(s)))
        : allowed;
      storeParam = JSON.stringify(intersect);
    }

    const data = await zwingFetch('/sales-report', { page, from_date, to_date, filtered_store: storeParam });
    res.json(data);
  } catch(e) {
    res.status(e.message === 'ZWING_AUTH_EXPIRED' ? 401 : 500).json({ error: e.message });
  }
});

app.get('/api/zwing/store-list', requireAuth, async (req, res) => {
  try {
    const data = await zwingFetch('/store-list');
    const user = req.session.user;
    // Filter stores for non-admin users
    if (user.role !== 'admin' && user.stores && user.stores.length > 0) {
      const stores = Array.isArray(data) ? data : (data.data || []);
      const filtered = stores.filter(s => user.stores.includes(String(s.store_id || s.id)));
      return res.json(filtered);
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/zwing/dashboard-data', requireAuth, async (req, res) => {
  try {
    const { from_date, to_date, filtered_store = '[]' } = req.query;
    const user = req.session.user;

    let storeParam = filtered_store;
    if (user.role !== 'admin' && user.stores?.length > 0) {
      let requested = [];
      try { requested = JSON.parse(filtered_store); } catch(e) {}
      const allowed = user.stores;
      const intersect = requested.length > 0 ? requested.filter(s => allowed.includes(String(s))) : allowed;
      storeParam = JSON.stringify(intersect);
    }

    // Fetch all pages
    let page = 1, allRows = [];
    while (true) {
      const result = await zwingFetch('/sales-report', { page, from_date, to_date, filtered_store: storeParam });
      const rows = result.data?.data || [];
      allRows = allRows.concat(rows);
      if (page >= (result.data?.last_page || 1)) break;
      page++;
      if (page > 20) break;
    }
    res.json({ data: allRows });
  } catch(e) {
    res.status(e.message === 'ZWING_AUTH_EXPIRED' ? 401 : 500).json({ error: e.message });
  }
});

// ─── ZWING CREDENTIALS (admin only) ─────────────────────────────────────────
app.post('/api/admin/zwing-credentials', requireAuth, requireAdmin, (req, res) => {
  const { cookies, xsrf } = req.body;
  if (!cookies || !xsrf) return res.status(400).json({ error: 'Missing cookies or xsrf' });
  zwingCookies = cookies;
  zwingXsrf    = xsrf;
  // Optionally persist to env hint file
  res.json({ ok: true });
});

app.get('/api/admin/zwing-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    await zwingFetch('/store-list');
    res.json({ connected: true });
  } catch(e) {
    res.json({ connected: false, error: e.message });
  }
});

// ─── USER MANAGEMENT (admin only) ───────────────────────────────────────────
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const users = readUsers().map(u => ({ ...u, password: undefined }));
  res.json(users);
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { name, username, password, role, stores } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Missing fields' });
  const users = readUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username taken' });
  const newUser = {
    id: Date.now(),
    name, username,
    password: bcrypt.hashSync(password, 10),
    role: role || 'viewer',
    stores: role === 'admin' ? [] : (stores || [])
  };
  users.push(newUser);
  writeUsers(users);
  res.json({ ok: true, user: { ...newUser, password: undefined } });
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, username, password, role, stores } = req.body;
  const users = readUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users[idx] = {
    ...users[idx],
    name: name || users[idx].name,
    username: username || users[idx].username,
    role: role || users[idx].role,
    stores: role === 'admin' ? [] : (stores !== undefined ? stores : users[idx].stores),
    ...(password ? { password: bcrypt.hashSync(password, 10) } : {})
  };
  writeUsers(users);
  res.json({ ok: true, user: { ...users[idx], password: undefined } });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === 1) return res.status(400).json({ error: 'Cannot delete main admin' });
  const users = readUsers().filter(u => u.id !== id);
  writeUsers(users);
  res.json({ ok: true });
});

// ─── SERVE APP ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ginni Dashboard running on port ${PORT}`);
  if (!zwingCookies) console.log('⚠ Zwing credentials not set — log in as admin and configure in Settings');
});
