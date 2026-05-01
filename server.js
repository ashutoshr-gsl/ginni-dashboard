const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'users.json');
const SALES_FILE = path.join(__dirname, 'sales.json');
const GIP_TOKEN = process.env.GIP_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXBlIjoib3V0Ym91bmQiLCJhcHBJZCI6IjY5ZjQ5NjQwZGY2ZDI5YzBkY2Y2ODNmOSIsInNzb0VudGVycHJpc2VJZCI6IjAxSkRSUFIxUEQ2TkhTRE1HQTFGRUYwWTJBIiwiaWF0IjoxNzc3NjM2OTMwfQ.6-_wst37ZgYkTNhcWoos7tQdq1zFqfZRT0qFZuONOJ8';

// ── Users ──────────────────────────────────────────────────────────────────
function readUsers() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e) {}
  const d = [{id:1,name:'PM Admin',username:'admin',password:bcrypt.hashSync(process.env.ADMIN_PASSWORD||'Admin@123',10),role:'admin',stores:[]}];
  fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); return d;
}
function writeUsers(u) { fs.writeFileSync(DATA_FILE, JSON.stringify(u,null,2)); }

// ── Sales store (in-memory + file backup) ──────────────────────────────────
let salesData = [];
try {
  if (fs.existsSync(SALES_FILE)) salesData = JSON.parse(fs.readFileSync(SALES_FILE,'utf8'));
} catch(e) { salesData = []; }

function saveSales() {
  // Keep last 10000 records
  if (salesData.length > 10000) salesData = salesData.slice(-10000);
  try { fs.writeFileSync(SALES_FILE, JSON.stringify(salesData)); } catch(e) {}
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname,'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ginni2024',
  resave: false, saveUninitialized: false,
  cookie: { secure: false, maxAge: 12*60*60*1000 }
}));

const auth  = (req,res,next) => req.session?.user ? next() : res.status(401).json({error:'Login required'});
const admin = (req,res,next) => req.session?.user?.role==='admin' ? next() : res.status(403).json({error:'Admin only'});

// ── Auth ───────────────────────────────────────────────────────────────────
app.post('/api/login', (req,res) => {
  const {username,password} = req.body;
  const user = readUsers().find(u => u.username===username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({error:'Invalid username or password'});
  req.session.user = {id:user.id,name:user.name,username:user.username,role:user.role,stores:user.stores};
  res.json({ok:true, user:req.session.user});
});
app.post('/api/logout', (req,res) => { req.session.destroy(); res.json({ok:true}); });
app.get('/api/me', auth, (req,res) => res.json({user:req.session.user}));

// ── GIP Webhook receiver ───────────────────────────────────────────────────
// GIP pushes sales events here in real time
app.post('/webhook/gip', (req,res) => {
  try {
    const body = req.body;
    console.log('GIP webhook received:', JSON.stringify(body).slice(0,200));

    // Handle both single event and array
    const events = Array.isArray(body) ? body : [body];

    events.forEach(event => {
      // Extract invoice data from various GIP event formats
      const data = event.data || event.payload || event.invoice || event;

      if (!data) return;

      // Normalize the invoice record
      const record = {
        id: data.id || data.invoice_id || Date.now(),
        invoice_id: data.invoice_id || data.invoiceId || data.id || '',
        name: data.store_name || data.name || data.storeName || '',
        store_reference_code: data.store_reference_code || data.storeCode || '',
        City: data.City || data.city || '',
        location: data.location || '',
        date: data.date || data.invoiceDate || new Date().toISOString().slice(0,10),
        invoice_time: data.invoice_time || data.time || '',
        total: parseFloat(data.total || data.netAmount || 0),
        subtotal: parseFloat(data.subtotal || data.grossAmount || data.total || 0),
        tax: parseFloat(data.tax || data.taxAmount || 0),
        total_qty: parseInt(data.total_qty || data.quantity || data.qty || 0),
        customer_name: data.customer_name || data.customerName || '',
        method: data.method || data.paymentMode || '',
        item_level_promo: parseFloat(data.item_level_promo || 0),
        item_level_manual_discount: parseFloat(data.item_level_manual_discount || 0),
        bill_discount: parseFloat(data.bill_discount || 0),
        bill_level_manual_discount: parseFloat(data.bill_level_manual_discount || 0),
        received_at: new Date().toISOString()
      };

      // Avoid duplicates
      const exists = salesData.find(s => s.invoice_id && s.invoice_id === record.invoice_id);
      if (!exists && record.invoice_id) {
        salesData.push(record);
        saveSales();
      }
    });

    res.json({ok:true, received: events.length});
  } catch(e) {
    console.error('Webhook error:', e.message);
    res.status(500).json({error:e.message});
  }
});

// ── Dashboard data ─────────────────────────────────────────────────────────
app.get('/api/dashboard', auth, (req,res) => {
  const {from_date, to_date, store} = req.query;
  const user = req.session.user;

  let filtered = salesData;

  // Date filter
  if (from_date) filtered = filtered.filter(r => r.date >= from_date);
  if (to_date)   filtered = filtered.filter(r => r.date <= to_date);

  // Store filter
  if (store) filtered = filtered.filter(r =>
    String(r.store_reference_code) === String(store) || r.name === store
  );

  // Role-based store filter
  if (user.role !== 'admin' && user.stores?.length > 0) {
    filtered = filtered.filter(r => user.stores.includes(String(r.store_reference_code)));
  }

  res.json({ok:true, data:filtered, total:filtered.length});
});

// ── Store list from sales data ────────────────────────────────────────────
app.get('/api/stores', auth, (req,res) => {
  const user = req.session.user;
  const storeMap = {};
  salesData.forEach(r => {
    if (r.store_reference_code) {
      storeMap[r.store_reference_code] = { store_id: r.store_reference_code, name: r.name || r.store_reference_code };
    }
  });
  let stores = Object.values(storeMap);
  if (user.role !== 'admin' && user.stores?.length > 0) {
    stores = stores.filter(s => user.stores.includes(String(s.store_id)));
  }
  res.json(stores);
});

// ── Stats for settings page ────────────────────────────────────────────────
app.get('/api/stats', auth, admin, (req,res) => {
  res.json({
    total_records: salesData.length,
    last_received: salesData.length > 0 ? salesData[salesData.length-1].received_at : null,
    webhook_url: `${req.protocol}://${req.get('host')}/webhook/gip`
  });
});

// ── Clear data (admin) ─────────────────────────────────────────────────────
app.delete('/api/sales', auth, admin, (req,res) => {
  salesData = [];
  saveSales();
  res.json({ok:true});
});

// ── User management ────────────────────────────────────────────────────────
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
  users[i] = {...users[i], name:name||users[i].name, username:username||users[i].username,
    role:role||users[i].role, stores:role==='admin'?[]:(stores||users[i].stores),
    ...(password?{password:bcrypt.hashSync(password,10)}:{})};
  writeUsers(users); res.json({ok:true});
});

app.delete('/api/users/:id', auth, admin, (req,res) => {
  if(parseInt(req.params.id)===1) return res.status(400).json({error:'Cannot delete main admin'});
  writeUsers(readUsers().filter(u=>u.id!==parseInt(req.params.id)));
  res.json({ok:true});
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, () => console.log('Ginni Dashboard on port '+PORT));
