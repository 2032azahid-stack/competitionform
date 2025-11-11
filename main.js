require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const mongoose = require('mongoose');

const escapeHtml = (s='') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || '';
const TEACHER_PASS = process.env.TEACHER_PASS || 'Arkvic';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please';

if (!MONGO_URI) console.warn('⚠️ MONGO_URI not set. DB operations will fail until configured.');
mongoose.connect(MONGO_URI, { useNewUrlParser:true, useUnifiedTopology:true })
  .then(()=> console.log('✅ MongoDB connected'))
  .catch(err => console.warn('MongoDB connection error:', err.message));

const MemberSchema = new mongoose.Schema({
  name:{type:String,required:true},
  form:String,
  year:String,
  experience:String,
  past:{type:String,enum:['yes','no'],default:'no'},
  reason:String,
  feePaid:{type:Boolean,default:false},
  email:String
},{_id:false});

const GroupSchema = new mongoose.Schema({
  members:[MemberSchema],
  groupFeePaid:{type:Boolean,default:false},
  createdAt:{type:Date,default:Date.now}
});

const Group = mongoose.models.Group || mongoose.model('Group', GroupSchema);

app.use(bodyParser.urlencoded({ extended:true }));
app.use(bodyParser.json());
app.use(session({ secret:SESSION_SECRET, resave:false, saveUninitialized:false, cookie:{maxAge:60*60*1000} }));

app.get('/', (req,res)=>{ res.setHeader('Content-Type','text/html; charset=utf-8'); res.send(indexHTML()); });

app.post('/submit', async (req,res)=>{
  try{
    const { group, p1, p2 } = req.body||{};
    if(!p1||!p1.name) return res.status(400).json({ok:false,message:'Missing Player 1 name'});
    if(group!=='yes') return res.status(400).json({ok:false,message:'Please come back with a group.'});
    if(!p2||!p2.name) return res.status(400).json({ok:false,message:'Group entries must include both members.'});

    function normalizeEmail(raw){
      if(!raw) return '';
      if(raw.includes('@')) return null;
      const local = String(raw).trim().toLowerCase();
      if(!local) return '';
      return local+'@arkvictoria.org';
    }

    const p1email = normalizeEmail(p1.email||'');
    const p2email = normalizeEmail(p2.email||'');
    if(p1email===null||p2email===null) return res.status(400).json({ok:false,message:'Do not include @ in email'});

    const p1Paid = p1.fee==='yes';
    const p2Paid = p2.fee==='yes';
    if(!(p1Paid||p2Paid)) return res.status(400).json({ok:false,message:'Please go to Mr Smith (M22) To find out more. You cannot join.'});

    const members = [
      { name:p1.name, form:p1.form||'', year:p1.year||'', experience:p1.experience||'', past:p1.past||'no', reason:p1.reason||'', feePaid:p1Paid, email:p1email },
      { name:p2.name, form:p2.form||'', year:p2.year||'', experience:p2.experience||'', past:p2.past||'no', reason:p2.reason||'', feePaid:p2Paid, email:p2email }
    ];

    const g = new Group({ members, groupFeePaid: members.some(m=>m.feePaid) });
    await g.save();
    res.json({ok:true,id:g._id});
  }catch(err){
    console.error(err);
    res.status(500).json({ok:false,message:'Server error'});
  }
});

// 🧑‍🏫 Teacher Login / Logout / Dashboard

app.get('/teacher',(req,res)=>{ 
  if(req.session&&req.session.authenticated) return res.redirect('/teacher/dashboard'); 
  res.setHeader('Content-Type','text/html; charset=utf-8'); 
  res.send(teacherLogin('')); 
});

app.post('/teacher/login',(req,res)=>{
  const pw=String((req.body&&req.body.password)||'');
  if(TEACHER_PASS&&pw===TEACHER_PASS){ req.session.authenticated=true; return res.redirect('/teacher/dashboard'); }
  res.send(teacherLogin('Incorrect password'));
});

app.get('/teacher/logout',(req,res)=>{ req.session.destroy(()=>res.redirect('/teacher')); });

// 🗑️ Delete group
app.post('/teacher/delete/:id', async (req,res)=>{
  if(!(req.session&&req.session.authenticated)) return res.status(401).send('Unauthorized');
  await Group.deleteOne({_id:req.params.id});
  res.redirect('/teacher/dashboard');
});

// Dashboard + export
app.get('/teacher/dashboard', async (req,res)=>{
  if(!(req.session&&req.session.authenticated)) return res.redirect('/teacher');
  const q=(req.query.q||'').trim();
  let filter={};
  if(q){
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
    filter = {$or:[{'members.name':rx},{'members.form':rx},{'members.year':rx},{'members.email':rx}]};
  }
  const groups = await Group.find(filter).sort({createdAt:-1}).lean();
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(teacherDashboard(groups,q));
});

app.get('/teacher/export.csv', async (req,res)=>{
  if(!(req.session&&req.session.authenticated)) return res.status(401).send('Unauthorized');
  const groups = await Group.find().sort({createdAt:-1}).lean();
  const rows=[];
  rows.push(['First Name','First Year','First Form','First Email','First FeePaid','First PlayedBefore','Second Name','Second Year','Second Form','Second Email','Second FeePaid','Second PlayedBefore','GroupFeePaid','CreatedAt'].join(','));
  for(const g of groups){
    const m1=g.members[0]||{};
    const m2=g.members[1]||{};
    const line=[m1.name,m1.year,m1.form,m1.email,(m1.feePaid?'yes':'no'),m1.past,m2.name,m2.year,m2.form,m2.email,(m2.feePaid?'yes':'no'),m2.past,(g.groupFeePaid?'yes':'no'),(g.createdAt?g.createdAt.toISOString():'')].map(csvSafe).join(',');
    rows.push(line);
  }
  res.setHeader('Content-disposition','attachment; filename=entries.csv');
  res.setHeader('Content-Type','text/csv');
  res.send(rows.join('\n'));
});

function csvSafe(s=''){ return '"'+String(s).replace(/"/g,'""')+'"'; }

app.listen(PORT,()=>console.log(`🚀 Listening on port ${PORT}`));

function indexHTML(){ return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Poxel.io Tournament Entry</title>
<style>
:root{--navy:#011638;--accent:#1e90ff;--muted:#9fb3d9;--card:#071a33}
body{margin:0;background:linear-gradient(180deg,var(--navy),#00162a);color:#e8f4ff;font-family:Inter,system-ui,Arial}
.container{max-width:880px;margin:36px auto;padding:28px;border-radius:12px;background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));box-shadow:0 10px 30px rgba(0,0,0,0.5);position:relative}
img.logo{position:absolute;right:18px;top:18px;width:64px;height:64px;object-fit:contain;border-radius:6px;background:rgba(255,255,255,0.03);padding:6px}
.card{background:var(--card);padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.03)}
label{display:block;color:var(--muted);font-size:13px;margin-bottom:6px}
input,select,textarea{width:100%;padding:10px;border-radius:8px;background:transparent;border:1px solid rgba(255,255,255,0.06);color:#e8f4ff}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.btn{padding:10px 14px;border-radius:8px;background:linear-gradient(180deg,var(--accent),#0b6fe0);color:white;border:none;cursor:pointer}
.small{font-size:12px;color:#9fb3d9}
.hidden{display:none}
.notice{background:rgba(255,255,255,0.02);padding:12px;border-radius:8px;border-left:4px solid var(--accent);margin-bottom:12px}
</style>
</head>
<body>
<div class="container">
<img class="logo" src="https://s45750.pcdn.co/wp-content/uploads/victoria-academy-crest-630x630.png" alt="crest"/>
<div id="landing" class="card">
<h1>You are about to enter the form to enter the Poxel.io tournament.</h1>
<p class="small">All data will be recorded.</p>
<div style="margin-top:14px"><button id="enterBtn" class="btn">Enter</button></div>
</div>

<div id="formCard" class="card hidden">
<form id="entryForm">
<h2>Player 1</h2>
<div class="row"><label>Full Name</label><input name="p1[name]" required/></div>
<div class="row"><label>Form Group</label>
<select name="p1[form]" required><option value="">--select--</option><option>Yousafzai</option><option>Zephaniah</option><option>Cadbury</option><option>Watt</option><option>Tolkien</option></select></div>
<div class="row"><label>Year</label>
<select name="p1[year]" required><option value="">--select--</option><option>Year 7</option><option>Year 8</option></select></div>
<div class="row"><label>Experience with Poxel.IO</label><input name="p1[experience]" required/></div>
<div class="row"><label>Played before at Ark Victoria IT? (Yes/No)</label>
<select name="p1[past]" required><option value="">--select--</option><option value="yes">Yes</option><option value="no">No</option></select></div>
<div class="row"><label>Why do you want to join?</label><textarea name="p1[reason]" required></textarea></div>
<div class="row"><label>Do you have a group? (Yes/No)</label>
<select name="group" required><option value="">--select--</option><option value="yes">Yes</option><option value="no">No</option></select></div>
<div class="row"><label>Are you able to pay £1 fee?</label>
<select name="p1[fee]" required><option value="">--select--</option><option value="yes">Yes</option><option value="no">No</option></select></div>
<div class="row"><label>Email (without @)</label><input name="p1[email]" placeholder="e.g. john.smith" required/></div>

<div id="player2Card" class="hidden">
<h2>Player 2</h2>
<div class="row"><label>Full Name</label><input name="p2[name]" required/></div>
<div class="row"><label>Form Group</label>
<select name="p2[form]" required><option value="">--select--</option><option>Yousafzai</option><option>Zephaniah</option><option>Cadbury</option><option>Watt</option><option>Tolkien</option></select></div>
<div class="row"><label>Year</label>
<select name="p2[year]" required><option value="">--select--</option><option>Year 7</option><option>Year 8</option></select></div>
<div class="row"><label>Experience with Poxel.IO</label><input name="p2[experience]" required/></div>
<div class="row"><label>Played before at Ark Victoria IT? (Yes/No)</label>
<select name="p2[past]" required><option value="">--select--</option><option value="yes">Yes</option><option value="no">No</option></select></div>
<div class="row"><label>Why do you want to join?</label><textarea name="p2[reason]" required></textarea></div>
<div class="row"><label>Are you able to pay £1 fee?</label>
<select name="p2[fee]" required><option value="">--select--</option><option value="yes">Yes</option><option value="no">No</option></select></div>
<div class="row"><label>Email (without @)</label><input name="p2[email]" placeholder="e.g. jane.smith" required/></div>
<button type="submit" class="btn" style="margin-top:14px;">Submit</button>
</div>
</form>
<div id="message" class="notice hidden"></div>
</div>

<script>
const enterBtn=document.getElementById('enterBtn');
const landing=document.getElementById('landing');
const formCard=document.getElementById('formCard');
const player2Card=document.getElementById('player2Card');
const entryForm=document.getElementById('entryForm');
const messageDiv=document.getElementById('message');
enterBtn.onclick=function(){ landing.classList.add('hidden'); formCard.classList.remove('hidden'); player2Card.classList.remove('hidden'); }
entryForm.onsubmit=async function(e){
e.preventDefault();
const data={group:entryForm.group.value,p1:{},p2:{}};
for(const el of entryForm.elements){
  if(el.name){
    const m=el.name.match(/^p(1|2)\\[(.*)\\]$/);
    if(m) data['p'+m[1]][m[2]]=el.value;
  }
}
const res=await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const result=await res.json();
if(result.ok){ messageDiv.textContent='Form submitted!'; messageDiv.classList.remove('hidden'); entryForm.reset(); }
else{ messageDiv.textContent=result.message||'Error'; messageDiv.classList.remove('hidden'); }
}
</script>
</div>
</body>
</html>`;}

function teacherLogin(msg){return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Teacher Login</title><style>body{font-family:Inter,Arial;background:#071733;color:#e8f4ff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#02132a;padding:20px;border-radius:10px;width:420px}input{width:100%;padding:10px;margin-top:8px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.06);color:#e8f4ff}button{margin-top:12px;padding:10px;border-radius:8px;background:#1e90ff;border:none;color:white;cursor:pointer}.err{color:#ff9b9b;margin-top:8px}.small{font-size:13px;color:#9fb3d9}</style></head><body><div class="card"><h2>Teacher access</h2><p class="small">Enter password</p><form method="post" action="/teacher/login"><input name="password" placeholder="Password" required /><button type="submit">Login</button></form>${msg?(`<div class="err">${escapeHtml(msg)}</div>`):''}<p class="small" style="margin-top:8px">Password is stored in env var <code>TEACHER_PASS</code></p></div></body></html>`;}

function teacherDashboard(groups,q=''){
  const rows = groups.map(g=>{
    const m1=g.members[0]||{};
    const m2=g.members[1]||{};
    return `<tr>
<td>${escapeHtml(m1.name||'')}</td>
<td>${escapeHtml(m2.name||'')}</td>
<td>${escapeHtml(m1.year||'')} ${m2.name?('/ '+escapeHtml(m2.year||'')) : ''}</td>
<td>${escapeHtml(m1.form||'')} ${m2.name?('/ '+escapeHtml(m2.form||'')) : ''}</td>
<td>${escapeHtml(m1.experience||'')} ${m2.name?('/ '+escapeHtml(m2.experience||'')) : ''}</td>
<td>${escapeHtml(m1.past||'')} ${m2.name?('/ '+escapeHtml(m2.past||'')) : ''}</td>
<td>${escapeHtml(m1.email||'')} ${m2.name?('/ '+escapeHtml(m2.email||'')) : ''}</td>
<td>${(m1.feePaid?'yes':'no')} ${m2.name?('/ '+(m2.feePaid?'yes':'no')):''}</td>
<td>${g.groupFeePaid? 'yes':'no'}</td>
<td>${g.createdAt? new Date(g.createdAt).toLocaleString():''}</td>
<td><form method="post" action="/teacher/delete/${g._id}" onsubmit="return confirm('Delete this group?');"><button class="btn" style="background:#c0392b;">🗑️</button></form></td>
</tr>`;
  }).join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Teacher Dashboard</title><style>body{background:#061a33;color:#e8f4ff;font-family:Inter,Arial;margin:0}header{padding:16px;background:#02132a;display:flex;align-items:center;justify-content:space-between}input{padding:8px;border-radius:6px;border:none;background:rgba(255,255,255,0.08);color:white}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);text-align:left;font-size:13px}a.btn,button.btn{display:inline-block;padding:8px 10px;background:#1e90ff;color:white;border-radius:8px;text-decoration:none;border:none;cursor:pointer}</style></head><body>
<header><div><h2>Teacher Dashboard</h2><div style="color:#9fb3d9">${groups.length} groups</div></div>
<div><form method="get" action="/teacher/dashboard" style="display:inline"><input name="q" placeholder="search name/form/year/email" value="${escapeHtml(q||'')}" /></form>
<a class="btn" href="/teacher/export.csv">Export CSV</a> <a class="btn" href="/teacher/logout">Logout</a></div></header>
<div style="margin-top:12px;overflow:auto"><table><thead><tr><th>First</th><th>Second</th><th>Year</th><th>Form</th><th>Exp</th><th>Played Before</th><th>Email</th><th>Fee(each)</th><th>GroupFee</th><th>Created</th><th>Delete</th></tr></thead><tbody>${rows}</tbody></table></div>
</body></html>`;
}
