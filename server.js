const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'users.json');

function readUsers() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
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

let zwingCookies = process.env.ZWING_COOKIES || '';
let zwingXsrf    = process.env.ZWING_XSRF    || '';
const ZWING_REPORT_BASE = 'https://lc.gozwing.com/api/v1/report';
const ZWING_ADMIN_BASE  = 'https://lc.gozwing.com/admin';

function getHeaders() {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-XSRF-TOKEN': zwingXsrf,
    'X-CSRF-TOKEN': zwingXsrf,
    'Cookie': zwingCookies,
    'Origin': 'https://lc.gozwing.com',
    'Referer': 'https://lc.gozwing.com/admin/home',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };
}

async function zwingFetch(apiPath, params = {}) {
  const adminEndpoints = ['/store-list', '/Statelist', '/get-settings', '/listing-filter'];
  const isAdmin = adminEndpoints.some(p => apiPath.startsWith(p));

  let res;
  if (isAdmin) {
    // POST with multipart form data (as browser does)
    const { FormData } = require('node-fetch');
    const form = new FormData();
    Object.entries(params).forEach(([k,v]) => { if(v !== undefined && v !== '') form.append(k, v); });
    res = await fetch(ZWING_ADMIN_BASE + apiPath, {
      method: 'POST',
      headers: getHeaders(),
      body: form
    });
  } else {
    // GET with query params
    const url = new URL(ZWING_REPORT_BASE + apiPath);
    Object.entries(params).forEach(([k,v]) => { if(v !== undefined && v !== '') url.searchParams.set(k, v); });
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: getHeaders()
    });
  }

  if (res.status === 401 || res.status === 403) throw new Error('ZWING_AUTH_EXPIRED');
  if (!res.ok) throw new Error(`ZWING_ERROR_${res.status}`);
  return res.json();
}

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ginni-dashboard-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}

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

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/auth/me', requireAuth, (req, res) => { res.json({ user: req.session.user }); });

app.get('/api/zwing/sales-report', requireAuth, async (req, res) => {
  try {
    const { page = 1, from_date, to_date, filtered_store = '[]' } = req.query;
    const user = req.session.user;
    let storeParam = filtered_store;
    if (user.role !== 'admin' && user.stores?.length > 0) {
      let requested = []; try { requested = JSON.parse(filtered_store); } catch(e) {}
      const intersect = requested.length > 0 ? requested.filter(s => user.stores.includes(String(s))) : user.stores;
      storeParam = JSON.stringify(intersect);
    }
    const data = await zwingFetch('/sales-report', { page, from_date, to_date, filtered_store: storeParam });
    res.json(data);
  } catch(e) { res.status(e.message === 'ZWING_AUTH_EXPIRED' ? 401 : 500).json({ error: e.message }); }
});

app.get('/api/zwing/store-list', requireAuth, async (req, res) => {
  try {
    const data = await zwingFetch('/store-list');
    const user = req.session.user;
    if (user.role !== 'admin' && user.stores?.length > 0) {
      const stores = Array.isArray(data) ? data : (data.data || []);
      return res.json(stores.filter(s => user.stores.includes(String(s.store_id || s.id))));
    }
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/zwing/dashboard-data', requireAuth, async (req, res) => {
  try {
    const { from_date, to_date, filtered_store = '[]' } = req.query;
    const user = req.session.user;
    let storeParam = filtered_store;
    if (user.role !== 'admin' && user.stores?.length > 0) {
      let requested = []; try { requested = JSON.parse(filtered_store); } catch(e) {}
      const intersect = requested.length > 0 ? requested.filter(s => user.stores.includes(String(s))) : user.stores;
      storeParam = JSON.stringify(intersect);
    }
    let page = 1, allRows = [];
    while (true) {
      const result = await zwingFetch('/sales-report', { page, from_date, to_date, filtered_store: storeParam });
      allRows = allRows.concat(result.data?.data || []);
      if (page >= (result.data?.last_page || 1)) break;
      page++; if (page > 20) break;
    }
    res.json({ data: allRows });
  } catch(e) { res.status(e.message === 'ZWING_AUTH_EXPIRED' ? 401 : 500).json({ error: e.message }); }
});

app.post('/api/admin/zwing-credentials', requireAuth, requireAdmin, (req, res) => {
  const { cookies, xsrf } = req.body;
  if (!cookies || !xsrf) return res.status(400).json({ error: 'Missing fields' });
  zwingCookies = cookies;
  zwingXsrf = xsrf;
  res.json({ ok: true });
});

app.get('/api/admin/zwing-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    await zwingFetch('/store-list');
    res.json({ connected: true });
  } catch(e) { res.json({ connected: false, error: e.message }); }
});

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(readUsers().map(u => ({ ...u, password: undefined })));
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { name, username, password, role, stores } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Missing fields' });
  const users = readUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username taken' });
  const newUser = { id: Date.now(), name, username, password: bcrypt.hashSync(password, 10), role: role || 'viewer', stores: role === 'admin' ? [] : (stores || []) };
  users.push(newUser);
  writeUsers(users);
  res.json({ ok: true, user: { ...newUser, password: undefined } });
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, username, password, role, stores } = req.body;
  const users = readUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  users[idx] = { ...users[idx], name: name||users[idx].name, username: username||users[idx].username, role: role||users[idx].role, stores: role==='admin'?[]:(stores!==undefined?stores:users[idx].stores), ...(password?{password:bcrypt.hashSync(password,10)}:{}) };
  writeUsers(users);
  res.json({ ok: true, user: { ...users[idx], password: undefined } });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === 1) return res.status(400).json({ error: 'Cannot delete main admin' });
  writeUsers(readUsers().filter(u => u.id !== parseInt(req.params.id)));
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Ginni Dashboard on port ${PORT}`));
