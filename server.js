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
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e) {}
  const d = [{id:1,name:'PM Admin',username:'admin',password:bcrypt.hashSync(process.env.ADMIN_PASSWORD||'Admin@123',10),role:'admin',stores:[]}];
  writeUsers(d); return d;
}
function writeUsers(u) { fs.writeFileSync(DATA_FILE, JSON.stringify(u,null,2)); }

let zwingCookies = process.env.ZWING_COOKIES || '';
let zwingXsrf    = process.env.ZWING_XSRF    || '';

async function zwingFetch(apiPath, params={}) {
  // All endpoints live under /admin/ based on network inspection
  const base = 'https://lc.gozwing.com/admin';

  // POST with empty body - Zwing requires X-CSRF-TOKEN header (not X-XSRF-TOKEN)
  const url = new URL(base + apiPath);
  Object.entries(params).forEach(([k,v]) => { if(v!==undefined && v!=='') url.searchParams.set(k,String(v)); });
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRF-TOKEN': zwingXsrf,
    'Cookie': zwingCookies,
    'Origin': 'https://lc.gozwing.com',
    'Referer': 'https://lc.gozwing.com/admin/home',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
  };
  const res = await fetch(url.toString(), { method: 'POST', headers, body: null });

  if (res.status===401||res.status===403) throw new Error('ZWING_AUTH_EXPIRED');
  if (!res.ok) throw new Error('ZWING_ERROR_'+res.status);
  return res.json();
}

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));
app.use(session({
  secret: process.env.SESSION_SECRET||'ginni-secret-2024',
  resave:false, saveUninitialized:false,
  cookie:{secure:false, maxAge:8*60*60*1000}
}));

const requireAuth  = (req,res,next) => req.session?.user ? next() : res.status(401).json({error:'Not authenticated'});
const requireAdmin = (req,res,next) => req.session?.user?.role==='admin' ? next() : res.status(403).json({error:'Admin only'});

app.post('/api/auth/login',(req,res)=>{
  const {username,password}=req.body;
  const user=readUsers().find(u=>u.username===username);
  if(!user||!bcrypt.compareSync(password,user.password)) return res.status(401).json({error:'Invalid username or password'});
  req.session.user={id:user.id,name:user.name,username:user.username,role:user.role,stores:user.stores};
  res.json({ok:true,user:req.session.user});
});
app.post('/api/auth/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({user:req.session.user}));

app.post('/api/admin/zwing-credentials',requireAuth,requireAdmin,(req,res)=>{
  const {cookies,xsrf}=req.body;
  if(!cookies||!xsrf) return res.status(400).json({error:'Missing fields'});
  zwingCookies=cookies; zwingXsrf=xsrf;
  res.json({ok:true});
});

app.get('/api/admin/zwing-status',requireAuth,requireAdmin,async(req,res)=>{
  try{
    const today = new Date().toISOString().slice(0,10);
    const weekAgo = new Date(Date.now()-7*24*60*60*1000).toISOString().slice(0,10);
    await zwingFetch('/sales-report',{page:1,from_date:weekAgo,to_date:today,filtered_store:'[]'});
    res.json({connected:true});
  }
  catch(e){ res.json({connected:false,error:e.message}); }
});

app.get('/api/zwing/store-list',requireAuth,async(req,res)=>{
  try{
    const data=await zwingFetch('/store-list');
    const user=req.session.user;
    const stores=Array.isArray(data)?data:(data.data||[]);
    if(user.role!=='admin'&&user.stores?.length>0)
      return res.json(stores.filter(s=>user.stores.includes(String(s.store_id||s.id))));
    res.json(stores);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/zwing/sales-report',requireAuth,async(req,res)=>{
  try{
    const {page=1,from_date,to_date,filtered_store='[]'}=req.query;
    const user=req.session.user;
    let sp=filtered_store;
    if(user.role!=='admin'&&user.stores?.length>0){
      let req2=[];try{req2=JSON.parse(filtered_store);}catch(e){}
      const ix=req2.length>0?req2.filter(s=>user.stores.includes(String(s))):user.stores;
      sp=JSON.stringify(ix);
    }
    const data=await zwingFetch('/sales-report',{page,from_date,to_date,filtered_store:sp});
    res.json(data);
  }catch(e){res.status(e.message==='ZWING_AUTH_EXPIRED'?401:500).json({error:e.message});}
});

app.get('/api/zwing/dashboard-data',requireAuth,async(req,res)=>{
  try{
    const {from_date,to_date,filtered_store='[]'}=req.query;
    const user=req.session.user;
    let sp=filtered_store;
    if(user.role!=='admin'&&user.stores?.length>0){
      let req2=[];try{req2=JSON.parse(filtered_store);}catch(e){}
      const ix=req2.length>0?req2.filter(s=>user.stores.includes(String(s))):user.stores;
      sp=JSON.stringify(ix);
    }
    let page=1,all=[];
    while(true){
      const r=await zwingFetch('/sales-report',{page,from_date,to_date,filtered_store:sp});
      all=all.concat(r.data?.data||[]);
      if(page>=(r.data?.last_page||1))break;
      page++;if(page>20)break;
    }
    res.json({data:all});
  }catch(e){res.status(e.message==='ZWING_AUTH_EXPIRED'?401:500).json({error:e.message});}
});

app.get('/api/users',requireAuth,requireAdmin,(req,res)=>res.json(readUsers().map(u=>({...u,password:undefined}))));
app.post('/api/users',requireAuth,requireAdmin,(req,res)=>{
  const {name,username,password,role,stores}=req.body;
  if(!name||!username||!password) return res.status(400).json({error:'Missing fields'});
  const users=readUsers();
  if(users.find(u=>u.username===username)) return res.status(400).json({error:'Username taken'});
  const nu={id:Date.now(),name,username,password:bcrypt.hashSync(password,10),role:role||'viewer',stores:role==='admin'?[]:(stores||[])};
  users.push(nu);writeUsers(users);
  res.json({ok:true,user:{...nu,password:undefined}});
});
app.put('/api/users/:id',requireAuth,requireAdmin,(req,res)=>{
  const id=parseInt(req.params.id);
  const {name,username,password,role,stores}=req.body;
  const users=readUsers();
  const i=users.findIndex(u=>u.id===id);
  if(i===-1) return res.status(404).json({error:'Not found'});
  users[i]={...users[i],name:name||users[i].name,username:username||users[i].username,role:role||users[i].role,stores:role==='admin'?[]:(stores!==undefined?stores:users[i].stores),...(password?{password:bcrypt.hashSync(password,10)}:{})};
  writeUsers(users);res.json({ok:true,user:{...users[i],password:undefined}});
});
app.delete('/api/users/:id',requireAuth,requireAdmin,(req,res)=>{
  if(parseInt(req.params.id)===1) return res.status(400).json({error:'Cannot delete main admin'});
  writeUsers(readUsers().filter(u=>u.id!==parseInt(req.params.id)));
  res.json({ok:true});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log('Ginni Dashboard on port '+PORT));
