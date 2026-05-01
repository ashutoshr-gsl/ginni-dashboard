const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'users.json');
const CREDS_FILE = path.join(__dirname, 'zwing-creds.json');

function readUsers() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e) {}
  const d = [{id:1,name:'PM Admin',username:'admin',password:bcrypt.hashSync(process.env.ADMIN_PASSWORD||'Admin@123',10),role:'admin',stores:[]}];
  fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); return d;
}
function writeUsers(u) { fs.writeFileSync(DATA_FILE, JSON.stringify(u,null,2)); }

let zwingCookies = '';
let zwingXsrf = '';
try {
  if (fs.existsSync(CREDS_FILE)) {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE,'utf8'));
    zwingCookies = c.cookies || '';
    zwingXsrf = c.xsrf || '';
  }
} catch(e) {}

async function fetchSalesData(from_date, to_date, filtered_store) {
  const url = new URL('https://lc.gozwing.com/api/v1/report/sales-report');
  url.searchParams.set('page', '1');
  if (from_date) url.searchParams.set('from_date', from_date);
  if (to_date) url.searchParams.set('to_date', to_date);
  url.searchParams.set('filtered_store', filtered_store || '[]');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': zwingXsrf,
      'Cookie': zwingCookies,
      'Referer': 'https://lc.gozwing.com/admin/report/sales',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  if (!res.ok) throw new Error('ZWING_'+res.status);
  return res.json();
}

app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ginni2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 12*60*60*1000 }
}));

const auth = (req,res,next) => req.session?.user ? next() : res.status(401).json({error:'Login required'});
const admin = (req,res,next) => req.session?.user?.role==='admin' ? next() : res.status(403).json({error:'Admin only'});

app.post('/api/login', (req,res) => {
  const {username, password} = req.body;
  const user = readUsers().find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({error:'Invalid username or password'});
  req.session.user = {id:user.id, name:user.name, username:user.username, role:user.role, stores:user.stores};
  res.json({ok:true, user:req.session.user});
});

app.post('/api/logout', (req,res) => { req.session.destroy(); res.json({ok:true}); });
app.get('/api/me', auth, (req,res) => res.json({user:req.session.user}));

// Save Zwing credentials
app.post('/api/credentials', auth, admin, (req,res) => {
  const {cookies, xsrf} = req.body;
  if (!cookies || !xsrf) return res.status(400).json({error:'Both fields required'});
  zwingCookies = cookies;
  zwingXsrf = xsrf;
  fs.writeFileSync(CREDS_FILE, JSON.stringify({cookies, xsrf}));
  res.json({ok:true});
});

// Test Zwing connection
app.get('/api/test-connection', auth, admin, async (req,res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const week = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
    const data = await fetchSalesData(week, today, '[]');
    const count = data?.data?.total || data?.pagination?.total || 0;
    res.json({ok:true, message:`Connected! Found ${count} transactions this week.`});
  } catch(e) {
    res.json({ok:false, error:e.message});
  }
});

// Dashboard data
app.get('/api/dashboard', auth, async (req,res) => {
  try {
    const {from_date, to_date, store} = req.query;
    const filtered_store = store ? '['+store+']' : '[]';
    
    // Fetch all pages
    let page = 1, all = [];
    while(page <= 20) {
      const url = new URL('https://lc.gozwing.com/api/v1/report/sales-report');
      url.searchParams.set('page', page);
      if(from_date) url.searchParams.set('from_date', from_date);
      if(to_date) url.searchParams.set('to_date', to_date);
      url.searchParams.set('filtered_store', filtered_store);
      const r = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-TOKEN': zwingXsrf,
          'Cookie': zwingCookies,
          'Referer': 'https://lc.gozwing.com/admin/report/sales',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (!r.ok) throw new Error('ZWING_'+r.status);
      const d = await r.json();
      all = all.concat(d.data?.data || []);
      if (page >= (d.data?.last_page || 1)) break;
      page++;
    }
    res.json({ok:true, data:all});
  } catch(e) {
    res.status(500).json({ok:false, error:e.message});
  }
});

// User management
app.get('/api/users', auth, admin, (req,res) => res.json(readUsers().map(u=>({...u,password:undefined}))));
app.post('/api/users', auth, admin, (req,res) => {
  const {name,username,password,role,stores} = req.body;
  if(!name||!username||!password) return res.status(400).json({error:'Missing fields'});
  const users = readUsers();
  if(users.find(u=>u.username===username)) return res.status(400).json({error:'Username taken'});
  const u = {id:Date.now(),name,username,password:bcrypt.hashSync(password,10),role:role||'viewer',stores:role==='admin'?[]:(stores||[])};
  users.push(u); writeUsers(users);
  res.json({ok:true});
});
app.put('/api/users/:id', auth, admin, (req,res) => {
  const users = readUsers();
  const i = users.findIndex(u=>u.id===parseInt(req.params.id));
  if(i===-1) return res.status(404).json({error:'Not found'});
  const {name,username,password,role,stores} = req.body;
  users[i] = {...users[i], name:name||users[i].name, username:username||users[i].username, role:role||users[i].role, stores:role==='admin'?[]:(stores||users[i].stores), ...(password?{password:bcrypt.hashSync(password,10)}:{})};
  writeUsers(users); res.json({ok:true});
});
app.delete('/api/users/:id', auth, admin, (req,res) => {
  if(parseInt(req.params.id)===1) return res.status(400).json({error:'Cannot delete main admin'});
  writeUsers(readUsers().filter(u=>u.id!==parseInt(req.params.id)));
  res.json({ok:true});
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, () => console.log('Ginni Dashboard running on port '+PORT));
