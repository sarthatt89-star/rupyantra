(function(){
'use strict';
const $=id=>document.getElementById(id);
const app=$('app'),msgs=$('msgs'),inp=$('inp'),stopBtn=$('stop'),form=$('form'),mic=$('mic');
const plus=$('plus'),menu=$('menu'),calcs=$('calcs'),imgIn=$('imgIn'),camIn=$('camIn'),fileIn=$('fileIn'),chips=$('chips'),note=$('note');
const DEBUG=/[?&]debug=1/.test(location.search);
const gens=$('gens'),genpill=$('genpill'),gentxt=$('gentxt'),hist=$('hist'),histBtn=$('histBtn'),scrim=$('scrim');
const API='/api/chat';
let convo=[],pending=[],log=[],gen=0,controller=null,activeBot=null,busy=false,noteTimer=null,rec=null,stopped=false,lastUserEl=null,lastDraft='',lastBot=null,speaking=null,noCard=false,streamMeta={},genFormat=null,genRun=false;
const MAX_FILES=3,MAX_B64=2700000,MAX_TOTAL_B64=3300000,MAX_PDF=2000000,MAX_CONTENT=12000,TEXT_PER_FILE=8000,MAX_TEXT_FILE=500000,REQUEST_TIMEOUT=55000;
const KEY2='rupeyantra_chat_v2',KEY3='rupeyantra_chats_v3',DB_NAME='rupeyantra_ai_files',DB_STORE='sessions',MAX_CHATS=30,PLACEHOLDER='Aapka agla sawal kya hai?';
const TEXT_EXT=/\.(txt|csv|tsv|json|md|log)$/i;
const FILE_BLOCK=/\[FILE: [^\]\n]{0,120}\][\s\S]*?(?:\[FILE END\]|$)/g;

function refresh(){form.classList.toggle('has-text',inp.value.trim().length>0||pending.length>0)}
function grow(){inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,200)+'px';refresh()}
function setBusy(b){busy=b;form.classList.toggle('busy',b)}
function warn(t){note.textContent=t;note.classList.add('show');clearTimeout(noteTimer);noteTimer=setTimeout(()=>note.classList.remove('show'),6000)}
const down=()=>{msgs.scrollTop=msgs.scrollHeight};
inp.addEventListener('input',grow);
inp.addEventListener('keydown',e=>{const touch=window.matchMedia&&matchMedia('(pointer:coarse)').matches;if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!touch){e.preventDefault();form.requestSubmit()}});
inp.addEventListener('paste',e=>{const f=Array.from((e.clipboardData&&e.clipboardData.files)||[]).filter(x=>x.type.startsWith('image/'));if(f.length){e.preventDefault();addFiles(f)}});
document.querySelectorAll('#starters [data-q]').forEach(b=>b.onclick=()=>{if(busy)return;inp.value=b.dataset.q;grow();form.requestSubmit()});

function setOpen(o){menu.classList.toggle('open',o);plus.classList.toggle('on',o);plus.setAttribute('aria-expanded',String(o));if(!o){calcs.classList.remove('open');gens.classList.remove('open');$('pickCalc').setAttribute('aria-expanded','false');$('pickGen').setAttribute('aria-expanded','false')}}
plus.onclick=e=>{e.stopPropagation();setOpen(!menu.classList.contains('open'))};
document.addEventListener('click',e=>{if(menu.classList.contains('open')&&!menu.contains(e.target)&&!plus.contains(e.target))setOpen(false)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')setOpen(false)});
$('pickPhoto').onclick=()=>imgIn.click();
$('pickFile').onclick=()=>fileIn.click();
$('pickText').onclick=()=>{if(!inp.value.trim())inp.value='Please explain this text:\n';grow();inp.focus();inp.setSelectionRange(inp.value.length,inp.value.length)};
$('pickCam').onclick=()=>{setOpen(false);camIn.click()};
$('pickReport').onclick=()=>{setOpen(false);inp.value='Create a short report of this conversation.';grow();inp.focus()};
$('pickCalc').onclick=e=>{e.stopPropagation();const o=calcs.classList.toggle('open');e.currentTarget.setAttribute('aria-expanded',String(o))};
[imgIn,camIn,fileIn].forEach(el=>el.onchange=()=>{const f=Array.from(el.files);el.value='';addFiles(f)});

/* storage: many chats, kept only in this browser */
function openDB(){return new Promise((resolve,reject)=>{if(!('indexedDB'in window)){reject(new Error('IndexedDB unavailable'));return}const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(DB_STORE))r.result.createObjectStore(DB_STORE)};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function dbPut(key,value){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).put(value,key);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
async function dbGet(key){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(DB_STORE,'readonly'),r=tx.objectStore(DB_STORE).get(key);r.onsuccess=()=>{db.close();resolve(r.result||null)};r.onerror=()=>{db.close();reject(r.error)}})}
async function dbDelete(key){try{const db=await openDB();await new Promise((resolve,reject)=>{const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).delete(key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()}catch(_){}}
const newId=()=>'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
let chats=[],cur={id:newId()},saveQueue=Promise.resolve();
const cleanFile=t=>String(t||'').replace(FILE_BLOCK,'[file content not saved]');
function titleOf(l){const u=l.find(x=>x.role==='user'),t=u?String(u.text||'').replace(/^📄\s*/,'').replace(/\s+/g,' ').trim():'';return (t||'New chat').slice(0,48)}
function save(){
  const i=chats.findIndex(c=>c.id===cur.id);
  if(log.length){
    const rec={id:cur.id,title:titleOf(log),t:Date.now(),log:log.slice(-60),history:convo.slice(-40).map(m=>({role:m.role,content:cleanFile(m.content)}))};
    if(i>=0)chats[i]=rec;else chats.unshift(rec);
    chats.sort((a,b)=>b.t-a.t);chats=chats.slice(0,MAX_CHATS);
  }else if(i>=0)chats.splice(i,1);
  renderHist();
  const snap={chats:chats,savedAt:Date.now()};
  saveQueue=saveQueue.then(()=>dbPut(KEY3,snap)).catch(()=>{
    try{localStorage.setItem(KEY3,JSON.stringify({chats:chats.slice(0,10).map(c=>({id:c.id,title:c.title,t:c.t,history:c.history.slice(-20),log:c.log.slice(-30).map(l=>({role:l.role,text:l.text,atts:(l.atts||[]).map(a=>({name:a.name,thumb:null}))}))}))}))}catch(_){}
  });
}
async function wipe(){chats=[];try{await saveQueue}catch(_){}try{[KEY3,KEY2,'rupeyantra_chat_v1'].forEach(k=>localStorage.removeItem(k))}catch(_){}await dbDelete(KEY3);await dbDelete(KEY2)}
const validChat=c=>c&&typeof c.id==='string'&&Array.isArray(c.log)&&c.log.length>0;

/* downloads */
function dl(name,mime,data){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type:mime}));a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000)}
const wrap=h=>'<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><style>table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px}</style></head><body><h2>Rupeyantra AI</h2>'+h+'</body></html>';
const sheet=el=>{const t=el.querySelectorAll('table');return t.length?Array.from(t).map(x=>x.outerHTML).join('<br>'):''};
function csvOf(tbl){const q=v=>'"'+v.replace(/"/g,'""')+'"';return '\ufeff'+Array.from(tbl.rows).map(r=>Array.from(r.cells).map(c=>q(c.textContent)).join(',')).join('\r\n')}
function printEl(el){
  const f=document.createElement('iframe');f.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  const c=el.cloneNode(true);c.querySelectorAll('.tools,.opts,.vf,iframe,.code .h').forEach(x=>x.remove());
  c.querySelectorAll('input').forEach(x=>x.setAttribute('value',x.value));c.querySelectorAll('details').forEach(x=>x.setAttribute('open',''));
  f.srcdoc='<!doctype html><meta charset="utf-8"><title>Rupeyantra AI</title><style>body{font:14px/1.6 system-ui,sans-serif;padding:20px;color:#000}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:5px;text-align:left}pre{white-space:pre-wrap}span>div:not(.tw):not(.code){white-space:pre-wrap}.tf{display:grid;gap:6px}label{font-size:12px;color:#444}.lgd{font-size:12px;color:#555}.pie{display:flex;gap:12px;align-items:center}.pie svg{width:100px}.ln{width:100%;height:100px}.bars{display:flex;gap:8px;align-items:flex-end;height:140px}.bars .b{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;font-size:11px}.bars .b span{display:block;width:70%}.big{font-size:22px;font-weight:700}.big small{display:block;font-size:12px;font-weight:400}</style><h2>Rupeyantra AI</h2>'+c.innerHTML;
  f.onload=()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(_){window.print()}setTimeout(()=>f.remove(),60000)};
  document.body.appendChild(f);
}
async function copyText(t,btn){
  let ok=false;try{await navigator.clipboard.writeText(t);ok=true}catch(e){const ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;opacity:0';document.body.appendChild(ta);ta.select();try{ok=document.execCommand('copy')}catch(_){}ta.remove()}
  const old=btn.textContent;btn.textContent=ok?'Copied ✓':'Copy failed';setTimeout(()=>{if(btn.isConnected)btn.textContent=old},1800);
}
function mk(row,label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>fn(b);row.appendChild(b);return b}
/* spoken replies use the voices built into the browser (no server audio) */
const MALE_V=/\b(male|rishi|prabhat|ravi|hemant|madhur|james|david|daniel|alex|fred|mark|george|guy|ryan|thomas|arthur|aaron|liam)\b/i;
const FEMALE_V=/\b(female|heera|neerja|kalpana|veena|lekha|samantha|karen|zira|susan|hazel|moira|tessa|fiona|victoria|aria|jenny|emma|sonia|libby|google uk english female)\b/i;
const canSpeak=()=>!!(window.speechSynthesis&&window.SpeechSynthesisUtterance);
function pickVoice(){
  const all=window.speechSynthesis?speechSynthesis.getVoices():[];
  const en=all.filter(v=>/^en/i.test(v.lang)),pool=en.length?en:all;
  const score=v=>{let s=0;if(/^en-IN/i.test(v.lang))s+=4;else if(/^en-(GB|US|AU)/i.test(v.lang))s+=2;if(MALE_V.test(v.name))s+=6;if(FEMALE_V.test(v.name))s-=8;if(/natural|neural|online|google/i.test(v.name))s+=1;if(v.localService)s+=.5;return s};
  return pool.slice().sort((a,b)=>score(b)-score(a))[0]||null;
}
function applyVoice(u){
  const v=pickVoice();
  if(v){u.voice=v;u.lang=v.lang}else u.lang='en-IN';
  u.pitch=v&&MALE_V.test(v.name)?.85:.7;
  u.rate=.94;u.volume=1;
}
let ttsToken=0;
function stopSpeech(){ttsToken++;try{if(window.speechSynthesis)speechSynthesis.cancel()}catch(_){}}
function chunkText(t){
  const clean=String(t||'').replace(/```[\s\S]*?```/g,' ').replace(/^\s*\|.*\|\s*$/gm,' ').replace(/https?:\/\/\S+/g,' ')
    .replace(/₹\s?([\d,]+(?:\.\d+)?)/g,'$1 rupees').replace(/(\d)\s?Cr\b/g,'$1 crore').replace(/(\d)\s?L\b/g,'$1 lakh')
    .replace(/[*|`#_>]/g,' ').replace(/\s+/g,' ').trim().slice(0,1600);
  const sents=clean.match(/[^.!?।]+[.!?।]?/g)||[clean],out=[];let cur2='';
  for(const x of sents){const s=x.trim();if(!s)continue;if(cur2&&(cur2+' '+s).length>380){out.push(cur2);cur2=s}else cur2=cur2?cur2+' '+s:s}
  if(cur2)out.push(cur2);
  return out.filter(Boolean).slice(0,6);
}
function browserSpeak(parts,my){
  return new Promise(res=>{
    const ss=window.speechSynthesis;
    if(!ss||!window.SpeechSynthesisUtterance){res('done');return}
    let k=0;
    const next=()=>{
      if(my!==ttsToken){res('stopped');return}
      if(k>=parts.length){res('done');return}
      const u=new SpeechSynthesisUtterance(parts[k++]);applyVoice(u);u.onend=next;u.onerror=next;ss.speak(u);
    };
    next();
  });
}
/* resolves 'done' or 'stopped' */
async function speakText(text,opt){
  stopSpeech();
  const my=ttsToken,parts=chunkText(text);
  if(!parts.length||!canSpeak())return 'done';
  if(opt&&opt.onStart)opt.onStart();
  return browserSpeak(parts,my);
}
function speak(t,btn){
  if(speaking===btn){stopSpeech();speaking=null;btn.textContent='🔊 Listen';return}
  const old=speaking;if(old&&old.isConnected)old.textContent='🔊 Listen';
  speaking=btn;btn.textContent='⏳ Loading…';
  speakText(t,{onStart:()=>{if(speaking===btn)btn.textContent='⏹ Stop'}}).then(()=>{if(speaking===btn){speaking=null;btn.textContent='🔊 Listen'}});
}

/* charts */
const C=['#0D9488','#2F5FDB','#7FA1F5'];
const F=n=>'₹'+Math.round(n).toLocaleString('en-IN');
const S=n=>n>=1e7?'₹'+(n/1e7).toFixed(2)+' Cr':n>=1e5?'₹'+(n/1e5).toFixed(2)+' L':F(n);
function pie(d){const t=d.reduce((s,x)=>s+x[1],0)||1,r=40,c=2*Math.PI*r;let o=0;
  const a=d.map((x,i)=>{const l=Math.max(0,x[1])/t*c,s='<circle r="'+r+'" cx="60" cy="60" fill="none" stroke="'+C[i]+'" stroke-width="22" stroke-dasharray="'+l+' '+(c-l)+'" stroke-dashoffset="'+(-o)+'" transform="rotate(-90 60 60)"/>';o+=l;return s}).join('');
  return '<div class="pie"><svg viewBox="0 0 120 120">'+a+'</svg><div class="lg">'+d.map((x,i)=>'<div><i style="background:'+C[i]+'"></i>'+x[0]+' · '+Math.round(Math.max(0,x[1])/t*100)+'% ('+S(x[1])+')</div>').join('')+'</div></div>'}
function bars(d){const m=Math.max(...d.map(x=>Math.abs(x[1])),1);
  return '<div class="bars">'+d.map((x,i)=>'<div class="b"><b>'+S(x[1])+'</b><span style="height:'+Math.max(2,Math.abs(x[1])/m*70)+'%;background:'+C[i%3]+'"></span><small>'+x[0]+'</small></div>').join('')+'</div>'}
function line(a,b,l1,l2){const m=Math.max(...a,...b,1),p=s=>s.map((v,i)=>(i/((s.length-1)||1)*200).toFixed(1)+','+(78-v/m*74).toFixed(1)).join(' ');
  return '<svg class="ln" viewBox="0 0 200 80" preserveAspectRatio="none"><polyline points="'+p(a)+'" fill="none" stroke="'+C[1]+'" stroke-width="2" vector-effect="non-scaling-stroke"/><polyline points="'+p(b)+'" fill="none" stroke="'+C[0]+'" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg><div class="lgd"><span style="color:'+C[1]+'">━</span> '+(l1||'Amount invested')+' &nbsp; <span style="color:'+C[0]+'">━</span> '+(l2||'Total value')+'</div>'}
const emi=(a,r,y)=>{const i=r/1200,n=Math.max(1,Math.round(y*12)),p=Math.pow(1+i,n);return {e:i?a*i*p/(p-1):a/n,n}};

const dur=mo=>Math.floor(mo/12)+' yr '+(mo%12)+' mo';
/* mini apps */
const TOOLS={
emi:{t:'🏠 EMI Calculator',f:[['Loan amount (₹)',5000000],['Interest rate (% per year)',8.5],['Tenure (years)',20],['Extra monthly payment (₹)',0]],c:(a,r,y,x)=>{
  const {e,n}=emi(a,r,y),i=r/1200,tot=e*n;
  let bal=a,intT=0,k=0,yp=0,yi=0,cp=0;const yr=[],P=[0],O=[a];
  while(a>0&&bal>0.005&&k<n+600){
    k++;const it=bal*i,pr=Math.min(bal,e+x-it);if(pr<=0)break;
    bal-=pr;intT+=it;yp+=pr;yi+=it;cp+=pr;
    if(k%12===0||bal<=0.005){const b=Math.max(0,bal);yr.push([Math.ceil(k/12),yp,yi,b]);P.push(cp);O.push(b);yp=0;yi=0}
  }
  const sched=yr.length?'<details class="am"><summary>Year-by-year schedule</summary><div class="tw"><table><thead><tr><th>Year</th><th>Principal</th><th>Interest</th><th>Balance</th></tr></thead><tbody>'+yr.map(z=>'<tr><td>'+z[0]+'</td><td>'+F(z[1])+'</td><td>'+F(z[2])+'</td><td>'+F(z[3])+'</td></tr>').join('')+'</tbody></table></div></details>':'';
  const rows=[['Loan amount',F(a)],['Total interest',F(intT)],['Total payment',F(a+intT)]];
  if(x>0)rows.push(['Loan closes in',dur(k)],['Interest saved',F(Math.max(0,tot-a-intT))]);
  return {m:['Monthly EMI',F(e)],rows,ch:pie([['Principal',a],['Interest',Math.max(0,intT)]])+line(P,O,'Principal repaid','Outstanding balance')+sched}}},
fd:{t:'🏦 FD Calculator',f:[['Deposit amount (₹)',500000],['Interest rate (% per year)',7],['Tenure (years)',5]],c:(p,r,y)=>{const v=k=>p*Math.pow(1+r/400,4*k),Y=Math.max(1,Math.ceil(y)),A=[],B=[];for(let k=0;k<=Y;k++){A.push(p);B.push(v(Math.min(k,y)))}const fv=v(y);return {m:['Maturity amount',S(fv)],rows:[['Deposit',F(p)],['Interest earned',F(fv-p)],['Maturity amount',F(fv)]],ch:line(A,B,'Deposit','Value')+'<div class="lgd">Assumes quarterly compounding. Enter the current rate from your bank.</div>'}}},
rd:{t:'🪙 RD Calculator',f:[['Monthly deposit (₹)',5000],['Interest rate (% per year)',6.5],['Tenure (years)',5]],c:(m,r,y)=>{const n=Math.max(1,Math.round(y*12)),val=k=>{let t=0;for(let j=1;j<=k;j++)t+=m*Math.pow(1+r/400,4*(k-j+1)/12);return t},A=[],B=[];for(let k=0;k<=Math.ceil(n/12);k++){const mo=Math.min(n,k*12);A.push(m*mo);B.push(val(mo))}const fv=val(n),inv=m*n;return {m:['Maturity amount',S(fv)],rows:[['Total deposited',F(inv)],['Interest earned',F(fv-inv)],['Maturity amount',F(fv)]],ch:line(A,B,'Deposited','Value')+'<div class="lgd">Assumes quarterly compounding. Enter the current rate from your bank.</div>'}}},
ppf:{t:'🏛️ PPF Calculator',f:[['Yearly deposit (₹)',150000],['Interest rate (% per year)',7.1],['Tenure (years)',15]],c:(d,r,y)=>{const Y=Math.max(1,Math.round(y)),i=r/100,A=[0],B=[0];let bal=0;for(let k=1;k<=Y;k++){bal=(bal+d)*(1+i);A.push(d*k);B.push(bal)}const inv=d*Y;return {m:['Maturity value',S(bal)],rows:[['Total deposited',F(inv)],['Interest earned',F(bal-inv)],['Maturity value',F(bal)]],ch:line(A,B,'Deposited','Value')+'<div class="lgd">Simplified: yearly deposit at the start of each year, compounded yearly. The rate and deposit limit are set by the government, so check the current figures on an official source.</div>'}}},
swp:{t:'💸 SWP Calculator',f:[['Starting corpus (₹)',5000000],['Monthly withdrawal (₹)',30000],['Expected return (% per year)',8],['Duration (years)',15]],c:(c0,w,r,y)=>{const i=r/1200,n=Math.max(1,Math.round(y*12));let bal=c0,took=0,lasted=n,dead=false;const A=[0],B=[c0];for(let k=1;k<=n;k++){if(!dead){const t=Math.min(w,bal);took+=t;bal=(bal-t)*(1+i);if(bal<=0.5){bal=0;dead=true;lasted=k}}if(k%12===0||k===n){A.push(took);B.push(bal)}}return {m:dead?['Corpus lasts for',dur(lasted)]:['Balance after '+dur(n),S(bal)],rows:[['Starting corpus',F(c0)],['Total withdrawn',F(took)],['Final balance',F(bal)],['Corpus lasts',dead?dur(lasted):'Full '+dur(n)]],ch:line(A,B,'Total withdrawn','Remaining balance')+(dead?'<div class="lgd">The corpus runs out before the chosen duration.</div>':'<div class="lgd">Returns are estimates, not guaranteed.</div>')}}},
lump:{t:'💼 Lumpsum Calculator',f:[['Investment (₹)',100000],['Expected return (% per year)',12],['Duration (years)',10]],c:(p,r,y)=>{const v=k=>p*Math.pow(1+r/100,k),Y=Math.max(1,Math.ceil(y)),A=[],B=[];for(let k=0;k<=Y;k++){A.push(p);B.push(v(Math.min(k,y)))}const fv=v(y);return {m:['Estimated value',S(fv)],rows:[['Invested',F(p)],['Estimated gains',F(fv-p)],['Estimated value',F(fv)]],ch:line(A,B,'Invested','Value')+'<div class="lgd">Returns are estimates, not guaranteed.</div>'}}},
stepsip:{t:'🪜 Step-up SIP Calculator',f:[['Starting monthly SIP (₹)',5000],['Yearly step-up (%)',10],['Expected return (% per year)',12],['Duration (years)',10]],c:(m,st,r,y)=>{const i=r/1200,n=Math.max(1,Math.round(y*12));let bal=0,inv=0;const A=[0],B=[0];for(let k=1;k<=n;k++){const q=m*Math.pow(1+st/100,Math.floor((k-1)/12));inv+=q;bal=(bal+q)*(1+i);if(k%12===0||k===n){A.push(inv);B.push(bal)}}return {m:['Estimated value',S(bal)],rows:[['Total invested',F(inv)],['Estimated gains',F(bal-inv)],['Estimated value',F(bal)]],ch:line(A,B)+'<div class="lgd">Returns are estimates, not guaranteed.</div>'}}},
cagr:{t:'📊 CAGR Calculator',f:[['Initial value (₹)',100000],['Final value (₹)',250000],['Duration (years)',5]],c:(a,b,y)=>{const g=a>0&&y>0&&b>0?Math.pow(b/a,1/y)-1:0,ab=a>0?(b-a)/a:0;return {m:['CAGR',(g*100).toFixed(2)+'% per year'],rows:[['Initial value',F(a)],['Final value',F(b)],['Absolute return',(ab*100).toFixed(2)+'%'],['CAGR',(g*100).toFixed(2)+'% per year']],ch:bars([['Initial',a],['Final',b]])}}},
ci:{t:'🔁 Compound Interest Calculator',f:[['Principal (₹)',100000],['Interest rate (% per year)',8],['Time (years)',5],['Compounded per year (times)',4]],c:(p,r,y,n)=>{n=Math.max(1,Math.round(n));const v=k=>p*Math.pow(1+r/(100*n),n*k),Y=Math.max(1,Math.ceil(y)),A=[],B=[];for(let k=0;k<=Y;k++){A.push(p);B.push(v(Math.min(k,y)))}const fv=v(y);return {m:['Maturity amount',S(fv)],rows:[['Principal',F(p)],['Interest earned',F(fv-p)],['Maturity amount',F(fv)]],ch:line(A,B,'Principal','Value')}}},
si:{t:'➕ Simple Interest Calculator',f:[['Principal (₹)',100000],['Interest rate (% per year)',8],['Time (years)',5]],c:(p,r,y)=>{const t=p*r*y/100;return {m:['Simple interest',F(t)],rows:[['Principal',F(p)],['Interest',F(t)],['Total amount',F(p+t)]],ch:bars([['Principal',p],['Interest',t]])}}},
infl:{t:'🎈 Inflation Calculator',f:[['Cost today (₹)',100000],['Inflation (% per year)',6],['Years',10]],c:(p,r,y)=>{const g=1+r/100,f=p*Math.pow(g,y),Y=Math.max(1,Math.ceil(y)),A=[],B=[];for(let k=0;k<=Y;k++){A.push(p);B.push(p*Math.pow(g,Math.min(k,y)))}return {m:['Future cost',S(f)],rows:[['Cost today',F(p)],['Cost after '+y+' years',F(f)],['Buying power of '+F(p)+' then',F(p/Math.pow(g,y))]],ch:line(A,B,'Cost today','Future cost')+'<div class="lgd">Inflation is an assumption; real inflation varies.</div>'}}},
retire:{t:'🌴 Retirement Planner',f:[['Current age',30],['Retirement age',60],['Life expectancy',85],['Monthly expenses today (₹)',40000],['Inflation (% per year)',6],['Return before retirement (% per year)',12],['Return after retirement (% per year)',7]],c:(age,ret,life,e,inf,pre,post)=>{const yrs=Math.max(0,ret-age),ry=Math.max(1,life-ret),w=e*Math.pow(1+inf/100,yrs),rr=(1+post/100)/(1+inf/100)-1,i=Math.pow(1+rr,1/12)-1,m=Math.round(ry*12),corpus=Math.abs(i)<1e-9?w*m:w*(1-Math.pow(1+i,-m))/i*(1+i),n=Math.max(1,Math.round(yrs*12)),j=pre/1200,sip=j?corpus*j/((Math.pow(1+j,n)-1)*(1+j)):corpus/n;return {m:['Corpus needed at retirement',S(corpus)],rows:[['Years to retirement',yrs+' years'],['Monthly expenses at retirement',F(w)],['Corpus needed',F(corpus)],['Monthly SIP needed',F(sip)],['Total you invest',F(sip*n)]],ch:bars([['Corpus needed',corpus],['You invest',sip*n]])+'<div class="lgd">Simplified estimate. Returns and inflation are assumptions.</div>'}}},
gst:{t:'🧾 GST Calculator',f:[['Amount (₹)',10000],['GST rate (%)',18],['Amount already includes GST? (1 = yes, 0 = no)',0]],c:(a,r,inc)=>{const b=inc>=0.5?a/(1+r/100):a,g=b*r/100;return {m:['Total with GST',F(b+g)],rows:[['Amount before GST',F(b)],['GST amount',F(g)],['Total with GST',F(b+g)]],ch:pie([['Base amount',b],['GST',g]])+'<div class="lgd">Enter the GST rate that applies to your item.</div>'}}},
afford:{t:'🏡 Loan Eligibility Calculator',f:[['Monthly income (₹)',100000],['Existing EMIs per month (₹)',10000],['Max share of income for EMIs (%)',50],['Interest rate (% per year)',8.5],['Tenure (years)',20]],c:(inc,ex,sh,r,y)=>{const mx=Math.max(0,inc*sh/100-ex),i=r/1200,n=Math.max(1,Math.round(y*12)),loan=i?mx*(1-Math.pow(1+i,-n))/i:mx*n;return {m:['Estimated eligible loan',S(loan)],rows:[['Max EMI you can afford',F(mx)],['Estimated loan amount',F(loan)],['Total interest',F(mx*n-loan)]],ch:bars([['Loan',loan],['Interest',Math.max(0,mx*n-loan)]])+'<div class="lgd">Banks apply their own rules. Check with your lender.</div>'}}},
cc:{t:'💳 Credit Card Payoff',f:[['Outstanding balance (₹)',50000],['Interest rate (% per year)',36],['Monthly payment (₹)',5000]],c:(b,r,pay)=>{const i=r/1200;let bal=b,k=0,ti=0;while(bal>0.5&&k<1200){const it=bal*i;if(k===0&&pay<=it)break;k++;ti+=it;bal=bal+it-Math.min(pay,bal+it)}return bal<=0.5?{m:['Debt-free in',dur(k)],rows:[['Months to pay off',k+' months'],['Total interest',F(ti)],['Total paid',F(b+ti)]],ch:pie([['Balance',b],['Interest',ti]])}:{m:['Payment too low','—'],rows:[['Monthly interest alone',F(b*i)]],ch:'<div class="lgd">Your payment does not cover the monthly interest, so the balance never falls. Increase the payment.</div>'}}},
emerg:{t:'🛟 Emergency Fund',f:[['Monthly expenses (₹)',30000],['Months to cover',6],['Already saved (₹)',50000],['Monthly saving (₹)',5000]],c:(e,mo,sv,ms)=>{const t=e*mo,gap=Math.max(0,t-sv),need=ms>0?Math.ceil(gap/ms):0;return {m:['Target fund',F(t)],rows:[['Already saved',F(sv)],['Still needed',F(gap)],['Time to reach target',gap<=0?'Target reached':ms>0?dur(need):'Add a monthly saving']],ch:bars([['Saved',sv],['Target',t]])}}},
tenure:{t:'⏳ Loan Tenure Calculator',f:[['Loan amount (₹)',5000000],['Interest rate (% per year)',8.5],['EMI you can pay (₹)',60000]],c:(L,r,E)=>{const i=r/1200;if(L<=0||E<=0)return {m:['Tenure','—'],rows:[],ch:''};if(i&&E<=L*i)return {m:['EMI too low','—'],rows:[['Monthly interest alone',F(L*i)]],ch:'<div class="lgd">This EMI does not cover the monthly interest. Increase the EMI.</div>'};const n=i?-Math.log(1-L*i/E)/Math.log(1+i):L/E,mo=Math.ceil(n),ti=E*n-L;return {m:['Loan tenure',dur(mo)],rows:[['Months to repay',mo+' months'],['Total interest',F(ti)],['Total payment',F(L+ti)]],ch:pie([['Principal',L],['Interest',Math.max(0,ti)]])}}},
dbl:{t:'✌️ Money Doubler',f:[['Amount (₹)',100000],['Interest rate (% per year)',8]],c:(a,r)=>{if(r<=0)return {m:['Time to double','—'],rows:[],ch:'<div class="lgd">Enter a rate above 0.</div>'};const ex=Math.log(2)/Math.log(1+r/100);return {m:['Time to double',ex.toFixed(1)+' years'],rows:[['Exact (compound)',ex.toFixed(1)+' years'],['Rule of 72 estimate',(72/r).toFixed(1)+' years'],['Amount then',F(a*2)]],ch:''}}},
sip:{t:'📈 SIP Calculator',f:[['Monthly SIP (₹)',5000],['Expected return (% per year)',12],['Duration (years)',10]],c:(m,r,y)=>{const i=r/1200,n=Math.max(1,Math.round(y*12)),v=k=>i?m*(Math.pow(1+i,k)-1)/i*(1+i):m*k,A=[],B=[];for(let k=0;k<=y;k++){A.push(m*k*12);B.push(v(k*12))}const fv=v(n),inv=m*n;return {m:['Estimated value',S(fv)],rows:[['Total invested',F(inv)],['Estimated gains',F(fv-inv)],['Total value',F(fv)]],ch:line(A,B)+'<div class="lgd">Returns are estimates, not guaranteed.</div>'}}},
goal:{t:'🎯 Goal Planner',f:[['Target amount (₹)',2500000],['Duration (years)',10],['Expected return (% per year)',12]],c:(t,y,r)=>{const i=r/1200,n=Math.max(1,Math.round(y*12)),m=i?t*i/((Math.pow(1+i,n)-1)*(1+i)):t/n;return {m:['Monthly SIP required',F(m)],rows:[['Target',F(t)],['Total invested',F(m*n)],['Estimated gains',F(t-m*n)]],ch:pie([['Your money',m*n],['Gains',Math.max(0,t-m*n)]])}}},
budget:{t:'💰 Budget Planner',f:[['Monthly income (₹)',40000],['Essential expenses (₹)',20000],['Wants (₹)',8000]],c:(inc,n,w)=>{const s=inc-n-w;return {m:['Monthly savings',(s<0?'−':'')+F(Math.abs(s))],rows:[['Savings rate',inc?Math.round(s/inc*100)+'%':'0%'],['Essentials',inc?Math.round(n/inc*100)+'%':'0%'],['Wants',inc?Math.round(w/inc*100)+'%':'0%']],ch:bars([['Essentials',n],['Wants',w],['Savings',Math.max(0,s)]])+(s<0?'<div class="lgd">Expenses exceed income.</div>':'<div class="lgd">Rule of thumb: 50% essentials, 30% wants, 20% savings.</div>')}}},
cmp:{t:'⚖️ Loan Comparison',f:[['Loan amount (₹)',5000000],['Tenure (years)',20],['Bank A rate (%)',8.5],['Bank B rate (%)',8.9]],c:(a,y,r1,r2)=>{const x=emi(a,r1,y),z=emi(a,r2,y),t1=x.e*x.n-a,t2=z.e*z.n-a;return {m:['Interest difference',F(Math.abs(t1-t2))],rows:[['Bank A EMI',F(x.e)],['Bank B EMI',F(z.e)],['Bank A total interest',F(t1)],['Bank B total interest',F(t2)]],ch:bars([['A interest',t1],['B interest',t2]])}}}
};
const INTENT=[[/eligib|afford/i,'afford'],[/loan tenure|how long.*(loan|emi)/i,'tenure'],[/\bemi\b|home loan|car loan|personal loan/i,'emi'],[/\bswp\b|systematic withdrawal/i,'swp'],[/\bppf\b/i,'ppf'],[/\bfd\b|fixed deposit/i,'fd'],[/\brd\b|recurring deposit/i,'rd'],[/step[- ]?up/i,'stepsip'],[/lump ?sum/i,'lump'],[/\bcagr\b/i,'cagr'],[/compound interest/i,'ci'],[/simple interest/i,'si'],[/inflation/i,'infl'],[/retire/i,'retire'],[/\bgst\b/i,'gst'],[/credit card/i,'cc'],[/emergency fund/i,'emerg'],[/rule of 72|double my money|money doubl/i,'dbl'],[/\bsip\b|mutual fund/i,'sip'],[/budget|bachat|saving/i,'budget'],[/goal|lakshya|target/i,'goal'],[/compar|tulna|\bvs\b/i,'cmp']];
function toolCard(k){
  const T=TOOLS[k],d=document.createElement('div');d.className='msg bot tool';
  d.innerHTML='<b>'+T.t+'</b><div class="tf">'+T.f.map(f=>'<label>'+f[0]+'<input type="number" inputmode="decimal" step="any" min="0" value="'+f[1]+'"></label>').join('')+'</div><div class="tr"></div>';
  const out=d.querySelector('.tr'),ins=Array.from(d.querySelectorAll('input'));
  const run=()=>{const was=(out.querySelector('details')||{}).open;const r=T.c(...ins.map(x=>Math.max(0,parseFloat(x.value)||0)));out.innerHTML='<div class="big"><small>'+r.m[0]+'</small>'+r.m[1]+'</div>'+r.ch+'<div class="tw"><table><tbody>'+r.rows.map(x=>'<tr><td>'+x[0]+'</td><td>'+x[1]+'</td></tr>').join('')+'</tbody></table></div>';if(was){const nd=out.querySelector('details');if(nd)nd.open=true}};
  ins.forEach(x=>x.oninput=run);run();
  const row=document.createElement('div');row.className='tools';
  mk(row,'Excel',()=>dl(k+'-rupeyantra.xls','application/vnd.ms-excel',wrap('<h3>'+T.t+'</h3>'+ins.map((x,i)=>T.f[i][0]+': '+x.value).join('<br>')+'<br><br>'+out.querySelector('.big').textContent+'<br>'+sheet(out))));
  mk(row,'CSV',()=>{const q=v=>'"'+String(v).replace(/"/g,'""')+'"',lines=[['Calculator',T.t.replace(/^\S+\s/,'')]].concat(ins.map((x,i)=>[T.f[i][0],x.value])).concat([[out.querySelector('.big small').textContent,out.querySelector('.big').lastChild.textContent]]).concat(Array.from(out.querySelectorAll('.tw:last-of-type tr')).map(r=>Array.from(r.cells).map(c=>c.textContent)));dl(k+'-rupeyantra.csv','text/csv;charset=utf-8','\ufeff'+lines.map(r=>r.map(q).join(',')).join('\r\n'))});
  mk(row,'PDF',()=>printEl(d));
  mk(row,'✨ Ask AI about this',()=>{
    if(busy)return;
    const bg=out.querySelector('.big'),res=Array.from(out.querySelectorAll('tr')).map(r=>Array.from(r.cells).map(c=>c.textContent).join(': ')).join('\n');
    noCard=true;
    inp.value='Explain this '+T.t.replace(/^\S+\s/,'')+' result in simple words and tell me what I should consider:\n'+ins.map((x,i)=>T.f[i][0]+': '+x.value).join('\n')+'\n'+bg.querySelector('small').textContent+': '+bg.lastChild.textContent+'\n'+res;
    grow();form.requestSubmit();
  });
  d.appendChild(row);msgs.appendChild(d);
  app.classList.add('chatting');down();
}
Object.keys(TOOLS).forEach(k=>{const b=document.createElement('button');b.type='button';const mm=/^(\S+)\s+(.*)$/.exec(TOOLS[k].t)||['','',TOOLS[k].t];const e=document.createElement('span');e.className='ce';e.textContent=mm[1];const nm=document.createElement('span');nm.textContent=mm[2].replace(/ Calculator$/,'');b.appendChild(e);b.appendChild(nm);b.onclick=()=>{setOpen(false);toolCard(k)};calcs.appendChild(b)});

/* messages UI */
function add(role,text){const d=document.createElement('div');d.className='msg '+role;d.textContent=text;msgs.appendChild(d);down();return d}
function addUser(text,atts){
  const d=document.createElement('div');d.className='msg user';
  (atts||[]).forEach(a=>{if(a.thumb){const im=document.createElement('img');im.src=a.thumb;im.alt=a.name||'Uploaded photo';d.appendChild(im)}else{const s=document.createElement('div');s.className='fl';s.textContent='📎 '+(a.name||'File');d.appendChild(s)}});
  if(text){const t=document.createElement('div');t.textContent=text;d.appendChild(t)}
  msgs.appendChild(d);down();return d;
}
function thinkingBot(){
  const d=document.createElement('div');d.className='msg bot thinking';
  const dot=document.createElement('span');dot.className='dot';dot.textContent='₹';
  const t=document.createElement('span');t.className='t';t.textContent='Thinking…';
  d.appendChild(dot);d.appendChild(t);msgs.appendChild(d);down();return d;
}
function showError(bot,text,retryFn){
  bot.classList.remove('thinking');bot.classList.add('err');bot.textContent=text;
  const tools=document.createElement('div');tools.className='tools';
  const retry=mk(tools,'Try again',retryFn);retry.className='retry';
  bot.appendChild(tools);down();
}
function botMsg(bot,text,animate,extra){
  bot.classList.remove('thinking','err');bot.innerHTML='';
  const span=document.createElement('span');bot.appendChild(span);
  const tools=document.createElement('div');tools.className='tools';
  const finish=()=>{
    if(!bot.isConnected)return;
    renderRich(span,text);
    mk(tools,'Copy',b=>copyText(text,b));
    if(canSpeak())mk(tools,'🔊 Listen',b=>speak(text,b));
    if(bot===lastBot)mk(tools,'🔄 Regenerate',()=>regen(bot));
    if(span.querySelector('table')){
      mk(tools,'Excel',()=>dl('rupeyantra.xls','application/vnd.ms-excel',wrap(sheet(span))));
      mk(tools,'CSV',()=>dl('rupeyantra.csv','text/csv;charset=utf-8',csvOf(span.querySelector('table'))));
    }
    if(text.length>300){
      mk(tools,'Word',()=>dl('rupeyantra.doc','application/msword',wrap(span.innerHTML)));
      mk(tools,'TXT',()=>dl('rupeyantra.txt','text/plain;charset=utf-8',text));
    }
    mk(tools,'PDF',()=>printEl(bot));
    mk(tools,'Share',b=>{const body=text+'\n\n- Rupeyantra AI (https://rupyantra-psi.vercel.app/ai.html)';if(navigator.share)navigator.share({text:body}).catch(()=>{});else copyText(body,b)});
    const up=mk(tools,'👍',()=>{const o=up.getAttribute('aria-pressed')!=='true';up.setAttribute('aria-pressed',String(o));dn.setAttribute('aria-pressed','false');if(o)warn('Thanks for the feedback.')});
    const dn=mk(tools,'👎',()=>{const o=dn.getAttribute('aria-pressed')!=='true';dn.setAttribute('aria-pressed',String(o));up.setAttribute('aria-pressed','false');if(o)warn('Thanks for the feedback. Please check important figures yourself.')});
    up.setAttribute('aria-label','Good answer');dn.setAttribute('aria-label','Poor answer');up.setAttribute('aria-pressed','false');dn.setAttribute('aria-pressed','false');
    if(extra&&extra.verified){const v=document.createElement('div');v.className='vf';v.textContent='✓ Verified by calculator';bot.appendChild(v)}
    bot.appendChild(tools);
    if(extra&&Array.isArray(extra.options)&&extra.options.length){
      const o=document.createElement('div');o.className='opts';
      extra.options.slice(0,6).forEach(t=>{
        if(typeof t!=='string'||!t)return;
        const b=document.createElement('button');b.type='button';b.textContent=t;
        b.onclick=()=>{if(busy)return;o.remove();inp.value=t;grow();form.requestSubmit()};
        o.appendChild(b);
      });
      if(o.children.length)bot.appendChild(o);
    }
    down();
  };
  const reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion:reduce)').matches;
  if(!animate||reduce||text.length<40){finish();return}
  const my=gen;let i=0;const step=Math.max(3,Math.ceil(text.length/90));
  const timer=setInterval(()=>{
    if(my!==gen||!bot.isConnected){clearInterval(timer);finish();return}
    i+=step;
    if(i>=text.length){clearInterval(timer);finish();return}
    span.textContent=text.slice(0,i);down();
  },18);
}
function regen(bot){
  if(busy||bot!==lastBot||!convo.length||convo[convo.length-1].role!=='assistant')return;
  convo.pop();if(log.length&&log[log.length-1].role==='bot')log.pop();
  bot.remove();lastBot=null;save();send();
}

/* rich replies */
function numify(p,s){s.split(/(₹\s?[\d,]+(?:\.\d+)?(?:\s?(?:lakh|crore|Lakh|Crore|L|Cr)\b)?)/).forEach((t,i)=>{if(!t)return;if(i%2){const n=document.createElement('span');n.className='num';n.textContent=t;p.appendChild(n)}else p.appendChild(document.createTextNode(t))})}
function inl(p,s){s.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/).forEach(part=>{
  let m;
  if(/^\*\*[^*]+\*\*$/.test(part)){const b=document.createElement('strong');numify(b,part.slice(2,-2));p.appendChild(b)}
  else if(/^`[^`]+`$/.test(part)){const c=document.createElement('code');c.className='mc';c.textContent=part.slice(1,-1);p.appendChild(c)}
  else if(m=/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part)){const a=document.createElement('a');a.href=m[2];a.target='_blank';a.rel='noopener noreferrer';a.textContent=m[1];p.appendChild(a)}
  else numify(p,part)})}
const isRow=l=>/^\s*\|.*\|\s*$/.test(l);
const isSep=l=>/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells=l=>l.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
const EXT={html:'html',js:'js',javascript:'js',python:'py',py:'py',css:'css',json:'json',csv:'csv',sql:'sql'};
function codeCard(lang,code){
  const d=document.createElement('div');d.className='code';
  const h=document.createElement('div');h.className='h';
  const nm=document.createElement('span');nm.textContent='💻 '+(lang||'code');h.appendChild(nm);
  mk(h,'Copy',b=>copyText(code,b));
  const ext=EXT[(lang||'').toLowerCase()]||'txt';
  mk(h,'⬇ .'+ext,()=>dl('rupeyantra-code.'+ext,'text/plain;charset=utf-8',code));
  const pre=document.createElement('pre'),cd=document.createElement('code');cd.textContent=code;pre.appendChild(cd);
  let fr=null;
  if(ext==='html')mk(h,'👁 Preview',()=>{
    if(fr){fr.remove();fr=null;return}
    fr=document.createElement('iframe');fr.setAttribute('sandbox','allow-scripts');fr.title='Preview';fr.srcdoc=code;d.appendChild(fr);
  });
  d.appendChild(h);d.appendChild(pre);return d;
}
function renderRich(el,text){
  el.textContent='';const L=text.split('\n');let buf=[];
  const flush=()=>{const t=buf.join('\n').trim();if(t){const d=document.createElement('div');inl(d,t);el.appendChild(d)}buf=[]};
  const BUL=/^\s*[-*•]\s+(.+)$/,NUM=/^\s*\d{1,2}[.)]\s+(.+)$/;
  for(let i=0;i<L.length;i++){
    const fence=/^\s*```\s*([\w+-]*)\s*$/.exec(L[i]);
    if(fence){
      flush();const c=[];i++;
      while(i<L.length&&!/^\s*```\s*$/.test(L[i])){c.push(L[i]);i++}
      el.appendChild(codeCard(fence[1],c.join('\n')));continue;
    }
    const hm=/^\s{0,3}#{1,4}\s+(.+?)\s*$/.exec(L[i]);
    if(hm){flush();const h=document.createElement('div');h.className='hd';inl(h,hm[1].replace(/\s*#+$/,''));el.appendChild(h);continue}
    const ord=NUM.test(L[i]);
    if(ord||BUL.test(L[i])){
      flush();const re=ord?NUM:BUL,ls=document.createElement(ord?'ol':'ul');
      while(i<L.length){const x=re.exec(L[i]);if(!x)break;const li=document.createElement('li');inl(li,x[1]);ls.appendChild(li);i++}
      i--;el.appendChild(ls);continue;
    }
    if(isRow(L[i])&&i+1<L.length&&isSep(L[i+1])){
      flush();
      const t=document.createElement('table'),th=document.createElement('thead'),tb=document.createElement('tbody'),hr=document.createElement('tr');
      cells(L[i]).forEach(c=>{const x=document.createElement('th');inl(x,c);hr.appendChild(x)});th.appendChild(hr);
      i+=2;
      while(i<L.length&&isRow(L[i])){const r=document.createElement('tr');cells(L[i]).forEach(c=>{const x=document.createElement('td');inl(x,c);r.appendChild(x)});tb.appendChild(r);i++}
      i--;t.appendChild(th);t.appendChild(tb);
      const w=document.createElement('div');w.className='tw';w.appendChild(t);el.appendChild(w);
    }else buf.push(L[i]);
  }
  flush();
}

/* attachments */
function readDataURL(f){return new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=()=>no(new Error('Could not read the file'));r.readAsDataURL(f)})}
function readText(f){return new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=()=>no(new Error('Could not read the file'));r.readAsText(f)})}
function loadImage(url){return new Promise((ok,no)=>{const im=new Image();im.onload=()=>ok(im);im.onerror=()=>no(new Error('This photo format is not supported'));im.src=url})}
function drawScaled(im,max,q){
  const s=Math.min(1,max/Math.max(im.naturalWidth,im.naturalHeight));
  const w=Math.max(1,Math.round(im.naturalWidth*s)),h=Math.max(1,Math.round(im.naturalHeight*s));
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,w,h);x.drawImage(im,0,0,w,h);
  return c.toDataURL('image/jpeg',q);
}
const b64Of=u=>u.split(',')[1]||'';
const pendingB64=()=>pending.reduce((n,p)=>n+(p.data?p.data.length:0),0);
async function prepareImage(f){
  const url=await readDataURL(f),im=await loadImage(url);
  const room=Math.min(MAX_B64,MAX_TOTAL_B64-pendingB64());
  for(const [max,q] of [[1600,.82],[1280,.78],[1024,.72],[800,.65]]){
    const data=b64Of(drawScaled(im,max,q));
    if(data.length&&data.length<=room)return {kind:'image',name:f.name||'photo.jpg',mime:'image/jpeg',data,thumb:drawScaled(im,120,.7)};
  }
  throw new Error('This photo is too large. Please send a smaller one');
}
async function preparePdf(f){
  if(f.size>MAX_PDF)throw new Error('PDF must be under 2 MB');
  const data=b64Of(await readDataURL(f));
  if(!data||data.length>MAX_TOTAL_B64-pendingB64())throw new Error('Total file size is too large');
  return {kind:'pdf',name:f.name||'file.pdf',mime:'application/pdf',data,thumb:null};
}
async function prepareText(f){
  if(f.size>MAX_TEXT_FILE)throw new Error('Text file is too large');
  const text=(await readText(f)).replace(/\u0000/g,'').trim();
  if(!text)throw new Error('File is empty');
  return {kind:'text',name:f.name||'file.txt',text:text.slice(0,TEXT_PER_FILE),thumb:null};
}
async function addFiles(files){
  for(const f of files){
    if(pending.length>=MAX_FILES){warn('You can attach up to '+MAX_FILES+' files at a time.');break}
    try{
      let item;
      if(f.type.startsWith('image/'))item=await prepareImage(f);
      else if(f.type==='application/pdf'||/\.pdf$/i.test(f.name))item=await preparePdf(f);
      else if(f.type.startsWith('text/')||f.type==='application/json'||TEXT_EXT.test(f.name))item=await prepareText(f);
      else throw new Error('Unsupported file type. Send a photo, PDF or text/CSV file');
      pending.push(item);
    }catch(e){warn((f.name?f.name+': ':'')+(e.message||'Could not attach the file'))}
  }
  renderChips();
}
function renderChips(){
  chips.innerHTML='';
  pending.forEach((p,idx)=>{
    const c=document.createElement('div');c.className='chip';
    if(p.thumb){const im=document.createElement('img');im.src=p.thumb;im.alt='';c.appendChild(im)}
    else{const ic=document.createElement('span');ic.className='ic';ic.textContent='📄';c.appendChild(ic)}
    const nm=document.createElement('span');nm.className='nm';nm.textContent=p.name;c.appendChild(nm);
    const x=document.createElement('button');x.type='button';x.textContent='×';x.setAttribute('aria-label','Remove '+p.name);
    x.onclick=()=>{pending.splice(idx,1);renderChips()};
    c.appendChild(x);chips.appendChild(c);
  });
  refresh();
}
function buildContent(text){
  const blocks=pending.filter(p=>p.kind==='text').map(p=>'[FILE: '+p.name.replace(/[\]\n\r]/g,' ').slice(0,100)+']\n'+p.text+'\n[FILE END]');
  if(!blocks.length)return text;
  const head=text||'Please review this file and tell me what it contains.';
  return (head+'\n\n'+blocks.join('\n\n')).slice(0,MAX_CONTENT);
}

/* send (streams when the server supports it, otherwise plain JSON) */
async function readStream(r,bot,my){
  const rd=r.body.getReader(),dec=new TextDecoder();
  let buf='',acc='',raf=0,span=null;
  streamMeta={};
  const paint=()=>{raf=0;if(!bot.isConnected||my!==gen)return;if(!span){bot.classList.remove('thinking','err');bot.innerHTML='';span=document.createElement('span');bot.appendChild(span)}renderRich(span,acc);down()};
  const handle=ln=>{
    ln=ln.trim();if(!ln.startsWith('data:'))return;
    const d=ln.slice(5).trim();if(!d||d==='[DONE]')return;
    let j;try{j=JSON.parse(d)}catch(_){return}
    if(j.error){const e=new Error(j.message||'No response right now. Please try again.');e.fromServer=true;throw e}
    if(typeof j.delta==='string'){acc+=j.delta;if(!raf)raf=requestAnimationFrame(paint)}
    if(j.done){if(typeof j.reply==='string'&&j.reply.trim())acc=j.reply;streamMeta={verified:j.verified===true,options:j.options}}
  };
  for(;;){const x=await rd.read();if(x.done)break;buf+=dec.decode(x.value,{stream:true});const ls=buf.split('\n');buf=ls.pop();ls.forEach(handle)}
  if(buf)handle(buf);
  if(raf)cancelAnimationFrame(raf);
  return acc.trim();
}
async function send(){
  const my=++gen;
  stopped=false;
  controller=new AbortController();
  const bot=thinkingBot();activeBot=bot;setBusy(true);
  const skipCard=noCard;noCard=false;
  let timedOut=false,serverData={};
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},REQUEST_TIMEOUT);
  try{
    const last=convo.length-1;
    const payload=convo.map((m,i)=>{const o={role:m.role,content:m.content};if(i===last&&m.attachments)o.attachments=m.attachments;return o});
    const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json','Accept':'text/event-stream, application/json;q=0.9'},body:JSON.stringify({messages:payload}),signal:controller.signal});
    let reply='',streamed=false;
    if(r.ok&&r.body&&(r.headers.get('content-type')||'').includes('text/event-stream')){
      streamed=true;
      reply=await readStream(r,bot,my);
      serverData=streamMeta;
    }else{
      try{serverData=await r.json()}catch(_){}
      reply=serverData&&typeof serverData.reply==='string'?serverData.reply.trim():'';
      if(!r.ok||!reply){
        const e=new Error((serverData&&serverData.message)||'No response right now. Please try again.');
        e.fromServer=true;throw e;
      }
    }
    if(my!==gen)return;
    if(!reply){const e=new Error('No response right now. Please try again.');e.fromServer=true;throw e}
    setBusy(false);
    const asked=lastDraft;
    lastUserEl=null;
    convo.push({role:'assistant',content:reply});
    log.push({role:'bot',text:reply});
    save();
    lastBot=bot;
    botMsg(bot,reply,!streamed,{verified:serverData.verified===true,options:serverData.options});
    if(voiceOn)vSpeak(reply);
    const hit=INTENT.find(x=>x[0].test(asked));
    if(hit&&!skipCard)toolCard(hit[1]);
  }catch(e){
    if(stopped||my!==gen)return;
    let msg=e&&e.fromServer?e.message:timedOut?'The response is taking too long. Please try again.':'Please check your connection and try again.';
    if(DEBUG){msg+='\n['+(e&&e.message||'')+']'+(serverData&&serverData.debug?'\n'+JSON.stringify(serverData.debug):'')}
    setBusy(false);
    showError(bot,msg,()=>{if(busy)return;bot.remove();send()});
    if(voiceOn)vSet('','No response. Tap the orb to try again.');
  }finally{
    clearTimeout(timer);
    if(my===gen&&busy)setBusy(false);
  }
}

form.addEventListener('submit',e=>{
  e.preventDefault();
  if(busy)return;
  const text=inp.value.trim();
  if(!text&&!pending.length)return;
  if(genFormat){if(!text)return;if(pending.length){warn('Remove attachments to create a file.');return}startGen(text);return}
  const content=buildContent(text);
  const atts=pending.filter(p=>p.kind!=='text');
  const msg={role:'user',content};
  if(atts.length)msg.attachments=atts.map(a=>({mime:a.mime,data:a.data}));
  convo.push(msg);
  const shown=pending.map(p=>({name:p.name,thumb:p.thumb||null}));
  log.push({role:'user',text,atts:shown});
  app.classList.add('chatting');
  lastUserEl=addUser(text,shown);lastDraft=text;
  pending=[];renderChips();
  inp.value='';grow();
  if(rec){try{rec.stop()}catch(_){}}
  save();
  send();
});

stopBtn.onclick=()=>{
  if(!busy)return;
  stopped=true;gen++;
  if(controller)controller.abort();
  if(activeBot&&activeBot.isConnected)activeBot.remove();
  if(genRun){genRun=false;if(lastUserEl&&lastUserEl.isConnected)lastUserEl.remove();lastUserEl=null;if(!inp.value.trim())inp.value=lastDraft||'';grow();if(!convo.length&&!log.length&&!msgs.children.length)app.classList.remove('chatting');setBusy(false);return}
  const lastMsg=convo[convo.length-1];
  if(lastMsg&&lastMsg.role==='user'){
    convo.pop();
    if(log.length&&log[log.length-1].role==='user')log.pop();
    if(lastUserEl&&lastUserEl.isConnected)lastUserEl.remove();
    lastUserEl=null;
    if(!inp.value.trim())inp.value=lastDraft||'';
    grow();save();
    if(!convo.length&&!log.length&&!msgs.children.length)app.classList.remove('chatting');
  }
  setBusy(false);
};

/* create file (uses /api/file; long files arrive in parts) */
const GEN_FORMATS={md:['Report','md','text/markdown;charset=utf-8'],csv:['Sheet (CSV)','csv','text/csv;charset=utf-8'],html:['Web page','html','text/html;charset=utf-8'],txt:['Text file','txt','text/plain;charset=utf-8'],json:['JSON','json','application/json;charset=utf-8']};
const GEN_MAX_PARTS=8;
Object.keys(GEN_FORMATS).forEach(k=>{const b=document.createElement('button');b.type='button';b.textContent=GEN_FORMATS[k][0];b.onclick=()=>{setOpen(false);setGen(k);inp.focus()};gens.appendChild(b)});
$('pickGen').onclick=e=>{e.stopPropagation();const o=gens.classList.toggle('open');e.currentTarget.setAttribute('aria-expanded',String(o))};
$('gencancel').onclick=()=>setGen(null);
function setGen(k){
  genFormat=k||null;
  genpill.hidden=!genFormat;
  if(genFormat){gentxt.textContent='📄 Create file · '+GEN_FORMATS[genFormat][0];inp.placeholder='Describe the file you want…'}
  else inp.placeholder=PLACEHOLDER;
}
const fmtSize=n=>n<1024?n+' characters':(n/1024).toFixed(1)+' KB';
function fileCard(text,fmt,name){
  const d=document.createElement('div');d.className='code';
  const h=document.createElement('div');h.className='h';
  const nm=document.createElement('span');nm.textContent='📄 '+name+' · '+fmtSize(text.length);h.appendChild(nm);
  mk(h,'Copy',b=>copyText(text,b));
  mk(h,'⬇ Download',()=>dl(name,GEN_FORMATS[fmt][2],(fmt==='csv'?'\ufeff':'')+text));
  const pre=document.createElement('pre'),cd=document.createElement('code');
  cd.textContent=text.length>20000?text.slice(0,20000)+'\n…':text;pre.appendChild(cd);
  d.appendChild(h);d.appendChild(pre);
  let pv=null;
  if(fmt==='html'||fmt==='md')mk(h,'👁 Preview',b=>{
    if(pv){pv.remove();pv=null;pre.style.display='';b.textContent='👁 Preview';return}
    if(fmt==='html'){pv=document.createElement('iframe');pv.setAttribute('sandbox','allow-scripts');pv.title='Preview';pv.srcdoc=text}
    else{pv=document.createElement('div');pv.className='mdv';renderRich(pv,text)}
    pre.style.display='none';b.textContent='Hide preview';d.appendChild(pv);
  });
  return d;
}
async function startGen(prompt){
  const fmt=genFormat,info=GEN_FORMATS[fmt];
  const my=++gen;stopped=false;controller=new AbortController();
  const hist=convo.slice(-6).map(m=>({role:m.role,content:String(m.content||'').slice(0,1500)}));
  app.classList.add('chatting');
  lastUserEl=addUser(prompt,[]);lastDraft=prompt;
  inp.value='';grow();
  if(rec){try{rec.stop()}catch(_){}}
  const bot=thinkingBot();activeBot=bot;setBusy(true);genRun=true;
  const label=bot.querySelector('.t');
  let text='',parts=0,more=false;const unverified=[];
  try{
    for(let part=1;part<=GEN_MAX_PARTS;part++){
      if(my!==gen)return;
      label.textContent='Writing your file… part '+part;
      let to=false,r,d={};
      const t=setTimeout(()=>{to=true;controller.abort()},REQUEST_TIMEOUT);
      try{
        r=await fetch('/api/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,format:fmt,part,tail:part>1?text.slice(-2000):undefined,history:hist}),signal:controller.signal});
        try{d=await r.json()}catch(_){}
      }catch(e){
        if(to){const x=new Error('Writing the file is taking too long. Please try again.');x.fromServer=true;throw x}
        throw e;
      }finally{clearTimeout(t)}
      if(my!==gen)return;
      if(!r.ok||!d||!d.ok||typeof d.text!=='string'){const e=new Error((d&&d.message)||'Could not create the file right now. Please try again.');e.fromServer=true;throw e}
      text+=d.text;parts=part;more=Boolean(d.truncated);
      (Array.isArray(d.unverified)?d.unverified:[]).forEach(x=>{if(typeof x==='string'&&!unverified.includes(x))unverified.push(x)});
      if(!more)break;
    }
    if(!text.trim()){const e=new Error('The file came back empty. Please try again.');e.fromServer=true;throw e}
    setBusy(false);genRun=false;lastUserEl=null;lastBot=null;
    const name='rupeyantra-file.'+info[1];
    const note='Your '+info[0].toLowerCase()+' is ready.'+(parts>1?' It was written in '+parts+' parts.':'')+
      (more?' It reached the length limit, so the end may be incomplete.':'')+
      (unverified.length?'\n\n**Please check these figures before using the file:** '+unverified.join(', ')+'. They were not confirmed by your inputs or a calculator.':'');
    convo.push({role:'user',content:'Create a file: '+prompt});
    convo.push({role:'assistant',content:'I created a '+info[0].toLowerCase()+' for this request ('+text.length+' characters).'});
    log.push({role:'user',text:'📄 '+prompt,atts:[]});
    log.push({role:'bot',text:note});
    save();
    botMsg(bot,note,false);
    bot.insertBefore(fileCard(text,fmt,name),bot.querySelector('.tools'));
    setGen(null);down();
  }catch(e){
    if(stopped||my!==gen)return;
    const msg=e&&e.fromServer?e.message:'Please check your connection and try again.';
    setBusy(false);genRun=false;
    showError(bot,msg,()=>{if(busy)return;bot.remove();if(lastUserEl&&lastUserEl.isConnected)lastUserEl.remove();lastUserEl=null;genFormat=fmt;startGen(prompt)});
  }finally{
    if(my===gen&&busy)setBusy(false);
  }
}

/* sidebar + chats */
const mobile=()=>!!(window.matchMedia&&matchMedia('(max-width:859px)').matches);
function sideOpen(){return mobile()?app.classList.contains('side-open'):!app.classList.contains('side-off')}
function syncSide(){histBtn.setAttribute('aria-expanded',String(sideOpen()))}
function closeSide(){if(mobile()){app.classList.remove('side-open');syncSide()}}
histBtn.onclick=()=>{if(mobile())app.classList.toggle('side-open');else app.classList.toggle('side-off');syncSide()};
scrim.onclick=closeSide;
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSide()});
if(window.matchMedia)matchMedia('(max-width:859px)').addEventListener&&matchMedia('(max-width:859px)').addEventListener('change',()=>{app.classList.remove('side-open');syncSide()});
syncSide();
function renderHist(){
  hist.textContent='';
  if(!chats.length){const p=document.createElement('li');p.className='hempty';p.textContent='Your chats will appear here.';hist.appendChild(p);return}
  chats.forEach(c=>{
    const li=document.createElement('li');if(c.id===cur.id)li.className='on';
    const b=document.createElement('button');b.type='button';b.className='ot';b.textContent=c.title||'New chat';b.title=c.title||'';
    if(c.id===cur.id)b.setAttribute('aria-current','true');
    b.onclick=()=>{if(c.id!==cur.id)openChat(c.id);closeSide()};
    const x=document.createElement('button');x.type='button';x.className='dx';x.textContent='×';x.setAttribute('aria-label','Delete chat: '+(c.title||'New chat'));
    x.onclick=()=>deleteChat(c.id);
    li.appendChild(b);li.appendChild(x);hist.appendChild(li);
  });
}
function resetView(){
  stopped=true;gen++;
  if(controller)controller.abort();
  if(rec){try{rec.stop()}catch(_){}}
  stopSpeech();speaking=null;
  if(voiceOn)$('vx').onclick();
  convo=[];log=[];pending=[];activeBot=null;lastUserEl=null;lastBot=null;genRun=false;setGen(null);
  msgs.innerHTML='';
  app.classList.remove('chatting');
  setBusy(false);renderChips();inp.value='';grow();
}
function openChat(id){
  const c=chats.find(x=>x.id===id);if(!c)return;
  resetView();cur={id:c.id};
  log=c.log.filter(l=>l&&(l.role==='user'||l.role==='bot')&&typeof l.text==='string');
  convo=(Array.isArray(c.history)?c.history:[]).filter(m=>m&&(m.role==='user'||m.role==='assistant')&&typeof m.content==='string');
  /* a chat saved while a reply was still pending ends with an unanswered question: drop it so the next send stays valid */
  if(convo.length&&convo[convo.length-1].role==='user'){convo.pop();if(log.length&&log[log.length-1].role==='user')log.pop()}
  if(!log.length){chats=chats.filter(x=>x.id!==id);renderHist();return}
  app.classList.add('chatting');
  const endsBot=convo.length&&convo[convo.length-1].role==='assistant';
  log.forEach((l,i)=>{if(l.role==='user')addUser(l.text,Array.isArray(l.atts)?l.atts:[]);else{const el=add('bot','');if(endsBot&&i===log.length-1)lastBot=el;botMsg(el,l.text,false)}});
  renderHist();down();
}
function newChat(){
  closeSide();
  if(!log.length&&!msgs.children.length){inp.focus();return}
  resetView();cur={id:newId()};renderHist();inp.focus();
}
function deleteChat(id){
  if(id===cur.id){resetView();cur={id:newId()}}
  chats=chats.filter(c=>c.id!==id);
  save();
}
$('newChat').onclick=newChat;
$('newChat2').onclick=newChat;
$('delAll').onclick=async()=>{
  if(!window.confirm('Delete all chat history stored in this browser? This cannot be undone.'))return;
  resetView();cur={id:newId()};
  await wipe();renderHist();closeSide();inp.focus();
};

/* theme */
const isDark=()=>{const t=document.documentElement.getAttribute('data-theme');return t?t==='dark':!!(window.matchMedia&&matchMedia('(prefers-color-scheme:dark)').matches)};
$('themeBtn').onclick=()=>{
  const t=isDark()?'light':'dark';
  document.documentElement.setAttribute('data-theme',t);
  try{localStorage.setItem('rupeyantra_theme',t)}catch(_){}
  const m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',t==='dark'?'#0B1226':'#F5F7FB');
};

/* speak your question */
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
if(!SR){mic.onclick=()=>warn('Voice input is not supported in this browser. Please use Chrome.')}
else{
  mic.onclick=()=>{
    if(rec){try{rec.stop()}catch(_){}return}
    const r=new SR();
    r.lang='en-IN';r.interimResults=false;r.continuous=false;
    r.onresult=ev=>{
      const t=Array.from(ev.results).map(x=>x[0].transcript).join(' ').trim();
      if(t){inp.value=(inp.value?inp.value+' ':'')+t;grow()}
    };
    r.onerror=ev=>{if(ev.error==='not-allowed'||ev.error==='service-not-allowed')warn('Please allow microphone access.');else if(ev.error!=='no-speech'&&ev.error!=='aborted')warn('Could not understand the audio. Please try again.')};
    r.onend=()=>{rec=null;mic.classList.remove('on')};
    rec=r;mic.classList.add('on');
    try{r.start()}catch(_){rec=null;mic.classList.remove('on')}
  };
}

/* voice mode */
let voiceOn=false,vMuted=false,vState='',vRec=null,vId=0;
const vo=$('vo'),orb=$('orb'),vst=$('vst');
function vSet(s,t){vState=s;orb.className=s;vst.textContent=t}
function vStop(){const r=vRec;vRec=null;if(r){r.onend=null;try{r.abort()}catch(_){}}}
function vListen(){
  if(!voiceOn||vMuted||busy||vRec)return;
  if(!SR){vSet('','Voice input is not supported in this browser. Please use Chrome.');return}
  stopSpeech();
  const r=new SR();r.lang='en-IN';r.interimResults=true;r.continuous=false;
  let fin='';
  r.onresult=ev=>{fin=Array.from(ev.results).map(x=>x[0].transcript).join(' ').trim();vst.textContent=fin};
  r.onerror=ev=>{if(ev.error==='not-allowed'||ev.error==='service-not-allowed')vSet('','Please allow microphone access.')};
  r.onend=()=>{
    vRec=null;if(!voiceOn)return;
    if(fin){vSet('think','Thinking…');inp.value=fin;grow();form.requestSubmit()}
    else if(vState==='listen'&&!vMuted)setTimeout(vListen,300);
  };
  vRec=r;vSet('listen','Go ahead, I’m listening…');
  try{r.start()}catch(_){vRec=null}
}
function vSpeak(t){
  if(!voiceOn)return;
  const id=++vId;
  vSet('talk','Preparing voice…');
  speakText(t,{onStart:()=>{if(id===vId&&voiceOn)vSet('talk','Speaking… tap the orb to interrupt')}}).then(r=>{
    if(id!==vId||!voiceOn||r==='stopped')return;
    vListen();
  });
}
$('vbtn').onclick=()=>{voiceOn=true;vMuted=false;$('vm').classList.remove('on');vo.classList.add('open');vListen()};
$('vx').onclick=()=>{voiceOn=false;vId++;vStop();stopSpeech();vo.classList.remove('open')};
$('vm').onclick=e=>{
  vMuted=!vMuted;e.currentTarget.classList.toggle('on',vMuted);
  if(vMuted){vStop();vSet('','Microphone is off.')}else vListen();
};
orb.onclick=()=>{
  if(vState==='talk'){vId++;stopSpeech();vListen()}
  else if(vState==='')vListen();
};

/* restore saved chats */
async function restore(){
  let snap=null;
  try{snap=await dbGet(KEY3)}catch(_){}
  if(!snap){try{snap=JSON.parse(localStorage.getItem(KEY3)||'null')}catch(_){}}
  let loaded=[];
  if(snap&&Array.isArray(snap.chats))loaded=snap.chats.filter(validChat);
  else{
    /* one-time move of the single chat saved by the previous version */
    let old=null;
    try{old=await dbGet(KEY2)}catch(_){}
    if(!old){try{old=JSON.parse(localStorage.getItem(KEY2)||'null')}catch(_){}}
    if(old&&Array.isArray(old.log)&&old.log.length)loaded=[{id:newId(),title:titleOf(old.log),t:old.savedAt||Date.now(),log:old.log,history:Array.isArray(old.history)?old.history:[]}];
  }
  const mine=chats.find(c=>c.id===cur.id);
  chats=loaded.filter(c=>!mine||c.id!==mine.id);
  if(mine)chats.unshift(mine);
  renderHist();
  if(!log.length&&!busy&&chats.length)openChat(chats[0].id);
}
restore().catch(()=>{});
grow();
inp.placeholder=PLACEHOLDER;
})();
