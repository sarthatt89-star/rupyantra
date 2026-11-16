(function(){
'use strict';
const $=id=>document.getElementById(id);
const app=$('app'),msgs=$('msgs'),inp=$('inp'),stopBtn=$('stop'),form=$('form'),mic=$('mic');
const plus=$('plus'),menu=$('menu'),imgIn=$('imgIn'),camIn=$('camIn'),fileIn=$('fileIn'),chips=$('chips'),note=$('note');
const DEBUG=/[?&]debug=1/.test(location.search);
const gens=$('gens'),genpill=$('genpill'),gentxt=$('gentxt');
const API='/api/chat';
/* Session id: chat server ko follow-up sawal (jaise "ab rate 9% kar do") yaad rakhne ke liye. Sirf ek random id, koi personal data nahi. */
function newSid(){try{const b=new Uint8Array(18);crypto.getRandomValues(b);return btoa(String.fromCharCode.apply(null,b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}catch(_){return null}}
function rotateSid(){const n=newSid();if(!n)return;SID=n;try{sessionStorage.setItem('rupeyantra_sid',n)}catch(_){}}
let SID=null;try{SID=sessionStorage.getItem('rupeyantra_sid');if(!SID){SID=newSid();if(SID)sessionStorage.setItem('rupeyantra_sid',SID)}}catch(_){SID=SID||newSid()}
let convo=[],pending=[],log=[],gen=0,controller=null,activeBot=null,busy=false,noteTimer=null,rec=null,stopped=false,lastUserEl=null,lastDraft='',lastBot=null,speaking=null,streamMeta={},genFormat=null,genRun=false;
const MAX_FILES=3,MAX_B64=2700000,MAX_TOTAL_B64=3300000,MAX_PDF=2000000,MAX_CONTENT=12000,TEXT_PER_FILE=8000,MAX_TEXT_FILE=500000,REQUEST_TIMEOUT=55000;
const PLACEHOLDER='Ask your next question';
const TEXT_EXT=/\.(txt|csv|tsv|json|md|log)$/i;

function refresh(){form.classList.toggle('has-text',inp.value.trim().length>0||pending.length>0)}
function grow(){inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,200)+'px';refresh();updCnt()}
function updCnt(){const c=$('cnt');if(!c)return;const n=inp.value.length;if(n>=3500){c.hidden=false;c.textContent=n.toLocaleString('en-IN')+' / 4,000';c.classList.toggle('warn',n>=3900)}else c.hidden=true}
function setBusy(b){busy=b;form.classList.toggle('busy',b)}
function warn(t){note.textContent=t;note.classList.add('show');clearTimeout(noteTimer);noteTimer=setTimeout(()=>note.classList.remove('show'),6000)}
/* Neeche tabhi le jao jab user pehle se neeche ke paas ho (ya naya message bheja ho), taaki upar padhte waqt jawab kheench kar na le jaye */
const down=f=>{if(f||msgs.scrollHeight-msgs.scrollTop-msgs.clientHeight<200)msgs.scrollTop=msgs.scrollHeight};
inp.addEventListener('input',grow);
inp.addEventListener('keydown',e=>{const touch=window.matchMedia&&matchMedia('(pointer:coarse)').matches;if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!touch){e.preventDefault();form.requestSubmit()}});
inp.addEventListener('paste',e=>{const f=Array.from((e.clipboardData&&e.clipboardData.files)||[]).filter(x=>x.type.startsWith('image/'));if(f.length){e.preventDefault();addFiles(f)}});
document.querySelectorAll('#starters [data-q]').forEach(b=>b.onclick=()=>{if(busy)return;inp.value=b.dataset.q;grow();form.requestSubmit()});

function setOpen(o){menu.classList.toggle('open',o);plus.classList.toggle('on',o);plus.setAttribute('aria-expanded',String(o));if(!o){gens.classList.remove('open');$('pickGen').setAttribute('aria-expanded','false')}}
plus.onclick=e=>{e.stopPropagation();setOpen(!menu.classList.contains('open'))};
document.addEventListener('click',e=>{if(menu.classList.contains('open')&&!menu.contains(e.target)&&!plus.contains(e.target))setOpen(false)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')setOpen(false)});
$('pickPhoto').onclick=()=>imgIn.click();
$('pickFile').onclick=()=>fileIn.click();
$('pickText').onclick=()=>{if(!inp.value.trim())inp.value='Please explain this text:\n';grow();inp.focus();inp.setSelectionRange(inp.value.length,inp.value.length)};
$('pickCam').onclick=()=>{setOpen(false);camIn.click()};
[imgIn,camIn,fileIn].forEach(el=>el.onchange=()=>{const f=Array.from(el.files);el.value='';addFiles(f)});

/* Chat history ab save nahi hoti. Purane version ka bacha hua data ek baar browser se mita diya jaata hai. */
(function purgeOldHistory(){
  try{if(localStorage.getItem('rupeyantra_hist_purged')==='1')return;['rupeyantra_chat_v1','rupeyantra_chat_v2','rupeyantra_chats_v3'].forEach(k=>localStorage.removeItem(k));localStorage.setItem('rupeyantra_hist_purged','1')}catch(_){}
  try{if('indexedDB'in window)indexedDB.deleteDatabase('rupeyantra_ai_files')}catch(_){}
})();

/* downloads */
function dl(name,mime,data){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type:mime}));a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000)}
const wrap=h=>'<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><style>table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px}</style></head><body><h2>Rupeyantra AI</h2>'+h+'</body></html>';
const sheet=el=>{const t=el.querySelectorAll('table');return t.length?Array.from(t).map(x=>x.outerHTML).join('<br>'):''};
function csvOf(tbl){const q=v=>'"'+v.replace(/"/g,'""')+'"';return '\ufeff'+Array.from(tbl.rows).map(r=>Array.from(r.cells).map(c=>q(c.textContent)).join(',')).join('\r\n')}
function printEl(el){
  const f=document.createElement('iframe');f.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  const c=el.cloneNode(true);c.querySelectorAll('.tools,.opts,.vf,iframe,.code .h').forEach(x=>x.remove());
  c.querySelectorAll('input').forEach(x=>x.setAttribute('value',x.value));c.querySelectorAll('details').forEach(x=>x.setAttribute('open',''));
  f.srcdoc='<!doctype html><meta charset="utf-8"><title>Rupeyantra AI</title><style>body{font:14px/1.6 system-ui,sans-serif;padding:20px;color:#000}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:5px;text-align:left}pre{white-space:pre-wrap}span>div:not(.tw):not(.code){white-space:pre-wrap}.blks{display:grid;gap:10px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.stat{border:1px solid #bbb;padding:6px 8px}.stat .l{display:block;font-size:11px;color:#555}.stat .v{font-weight:700}.blk{margin:10px 0}.blk h4{margin:0 0 6px;font-size:13px}.blk svg{width:100%;height:auto}.lg{font-size:11px;color:#555}.lg span{margin-right:12px}.lg i{display:inline-block;width:9px;height:9px;margin-right:4px}.hb{display:grid;grid-template-columns:90px 1fr auto;gap:6px;font-size:12px;margin:4px 0}.hb .t{background:#eee;height:10px}.hb .t b{display:block;height:100%}.ax{font-size:9px;fill:#555}.dn svg{width:120px}</style><h2>Rupeyantra AI</h2>'+c.innerHTML;
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


/* Result blocks (stat cards, charts, tables) sent by the calculator system.
   Built only with DOM methods (never innerHTML), so server data can never run as code. */
const SVGNS='http://www.w3.org/2000/svg';
const COLORS=['var(--c0,#3B5BDB)','var(--c1,#0E9AA7)','var(--c2,#7C5CFA)','var(--c3,#F59E0B)'];
const isNum=n=>typeof n==='number'&&isFinite(n);
const txt=(v,max)=>String(v==null?'':v).slice(0,max||60);
const trim0=s=>s.replace(/\.?0+$/,'');
const money=n=>{const a=Math.abs(n);return a>=1e7?'₹'+trim0((n/1e7).toFixed(2))+' Cr':a>=1e5?'₹'+trim0((n/1e5).toFixed(2))+' L':'₹'+Math.round(n).toLocaleString('en-IN')};
const fmtOf=b=>b&&b.unit==='%'?(n=>trim0(Number(n).toFixed(2))+'%'):b&&b.unit==='yrs'?(n=>trim0(Number(n).toFixed(1))+' yrs'):money;
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function svg(tag,attrs){const e=document.createElementNS(SVGNS,tag);for(const k in attrs||{})e.setAttribute(k,attrs[k]);return e}
function svgText(x,y,s,anchor){const t=svg('text',{x,y,class:'ax','text-anchor':anchor||'start'});t.textContent=s;return t}
function legend(items){const l=el('div','lg');items.forEach(it=>{const s=el('span');const i=el('i');i.style.background=it.color;s.appendChild(i);s.appendChild(document.createTextNode(it.text));l.appendChild(s)});return l}
function frame(title,label){const b=el('div','blk');b.setAttribute('role','group');b.setAttribute('aria-label',label||title);if(title)b.appendChild(el('h4',null,txt(title,80)));return b}
function cleanSeries(b){
  const x=Array.isArray(b.x)?b.x.slice(0,120).map(v=>txt(v,20)):[];
  const series=(Array.isArray(b.series)?b.series:[]).slice(0,4).map(s=>({name:txt(s&&s.name,30),values:Array.isArray(s&&s.values)?s.values.slice(0,x.length).map(v=>isNum(v)?v:0):[]})).filter(s=>s.values.length);
  return x.length&&series.length?{x,series}:null;
}
const shortX=s=>s.replace(/^Year\s+/i,'');
function xLabels(g,x,W,H,band,offset){
  const step=Math.max(1,Math.ceil(x.length/6));
  x.forEach((v,i)=>{if(i%step===0||i===x.length-1)g.appendChild(svgText(offset+i*band+band/2,H+12,shortX(v),'middle'))});
}

function statsBlock(b){
  const items=(Array.isArray(b.items)?b.items:[]).slice(0,6).filter(i=>i&&i.label!=null&&i.value!=null);
  if(!items.length)return null;
  const g=el('div','stats');
  items.forEach(i=>{const c=el('div','stat');c.appendChild(el('span','l',txt(i.label,40)));c.appendChild(el('b','v',txt(i.value,30)));g.appendChild(c)});
  return g;
}
function donutBlock(b){
  const M=fmtOf(b);
  const data=(Array.isArray(b.data)?b.data:[]).slice(0,4).filter(d=>d&&isNum(d.value)&&d.value>0);
  const total=data.reduce((s,d)=>s+d.value,0);
  if(!data.length||!total)return null;
  const f=frame(b.title,(b.title||'Chart')+': '+data.map(d=>txt(d.label,30)+' '+M(d.value)).join(', '));
  const wrap=el('div','dn');
  const s=svg('svg',{viewBox:'0 0 120 120',role:'img','aria-hidden':'true'});
  const r=42,c=2*Math.PI*r;let off=0;
  data.forEach((d,i)=>{const len=d.value/total*c;
    const ring=svg('circle',{cx:60,cy:60,r:r,fill:'none','stroke-width':20,'stroke-dasharray':len+' '+(c-len),'stroke-dashoffset':-off,transform:'rotate(-90 60 60)'});
    ring.style.stroke=COLORS[i];s.appendChild(ring);off+=len});
  s.appendChild(svgText(60,57,'Total','middle'));
  const t=svgText(60,71,M(total),'middle');t.setAttribute('class','ax big');s.appendChild(t);
  wrap.appendChild(s);
  wrap.appendChild(legend(data.map((d,i)=>({color:COLORS[i],text:txt(d.label,30)+': '+M(d.value)+' ('+Math.round(d.value/total*100)+'%)'}))));
  f.appendChild(wrap);return f;
}
function barBlock(b){
  const M=fmtOf(b);
  const data=(Array.isArray(b.data)?b.data:[]).slice(0,8).filter(d=>d&&isNum(d.value));
  if(!data.length)return null;
  const max=Math.max(...data.map(d=>Math.abs(d.value)),1);
  const f=frame(b.title,(b.title||'Chart')+': '+data.map(d=>txt(d.label,30)+' '+M(d.value)).join(', '));
  data.forEach((d,i)=>{const row=el('div','hb');row.appendChild(el('span',null,txt(d.label,24)));
    const t=el('span','t');const bar=el('b');bar.style.width=Math.max(2,Math.abs(d.value)/max*100)+'%';bar.style.background=COLORS[i%4];t.appendChild(bar);row.appendChild(t);
    row.appendChild(el('span',null,M(d.value)));f.appendChild(row)});
  return f;
}
function stackedBlock(b){
  const M=fmtOf(b);
  const d=cleanSeries(b);if(!d)return null;
  const n=d.x.length,W=300,H=130,band=W/n,bw=Math.max(2,band*.7);
  const totals=d.x.map((_,i)=>d.series.reduce((s,se)=>s+Math.max(0,se.values[i]||0),0)),max=Math.max(...totals,1);
  const f=frame(b.title,(b.title||'Chart')+' ('+d.series.map(s=>s.name).join(' and ')+' by '+(d.x[0]||'')+' to '+d.x[n-1]+')');
  const s=svg('svg',{viewBox:'0 0 '+W+' '+(H+18),role:'img','aria-hidden':'true'});
  s.appendChild(svgText(0,8,M(max),'start'));
  d.x.forEach((_,i)=>{let y=H;d.series.forEach((se,k)=>{const h=Math.max(0,se.values[i]||0)/max*(H-12);y-=h;
    const r=svg('rect',{x:i*band+(band-bw)/2,y:y,width:bw,height:Math.max(0,h),rx:1});r.style.fill=COLORS[k];s.appendChild(r)})});
  s.appendChild(svg('line',{x1:0,x2:W,y1:H,y2:H,stroke:'currentColor','stroke-opacity':.25}));
  xLabels(s,d.x,W,H,band,0);
  f.appendChild(s);f.appendChild(legend(d.series.map((se,k)=>({color:COLORS[k],text:se.name}))));return f;
}
function lineBlock(b,area){
  const M=fmtOf(b);
  const d=cleanSeries(b);if(!d)return null;
  const n=d.x.length,W=300,H=120,all=d.series.flatMap(s=>s.values),max=Math.max(...all,1),min=Math.min(0,...all);
  const px=i=>n===1?W/2:i/(n-1)*W,py=v=>(H-8)-(v-min)/((max-min)||1)*(H-20);
  const f=frame(b.title,(b.title||'Chart')+': '+d.series.map(s=>s.name+' reaches '+M(s.values[s.values.length-1])).join(', '));
  const s=svg('svg',{viewBox:'0 0 '+W+' '+(H+14),role:'img','aria-hidden':'true'});
  s.appendChild(svgText(0,8,M(max),'start'));
  s.appendChild(svg('line',{x1:0,x2:W,y1:H-8,y2:H-8,stroke:'currentColor','stroke-opacity':.25}));
  d.series.forEach((se,k)=>{
    const pts=se.values.map((v,i)=>px(i).toFixed(1)+','+py(v).toFixed(1));
    if(area&&k===0){const p=svg('polygon',{points:pts.join(' ')+' '+px(n-1).toFixed(1)+','+(H-8)+' '+px(0).toFixed(1)+','+(H-8)});p.style.fill=COLORS[k];p.setAttribute('fill-opacity','.15');s.appendChild(p)}
    const l=svg('polyline',{points:pts.join(' '),fill:'none','stroke-width':2.2,'stroke-linejoin':'round','stroke-linecap':'round'});l.style.stroke=COLORS[k];s.appendChild(l);
  });
  const step=Math.max(1,Math.ceil(n/6));
  d.x.forEach((v,i)=>{if(i%step===0||i===n-1)s.appendChild(svgText(px(i),H+6,shortX(v),i===0?'start':i===n-1?'end':'middle'))});
  f.appendChild(s);
  f.appendChild(legend(d.series.map((se,k)=>({color:COLORS[k],text:se.name+': '+M(se.values[se.values.length-1])}))));return f;
}
function tableBlock(b){
  const cols=(Array.isArray(b.columns)?b.columns:[]).slice(0,6).map(c=>txt(c,24));
  const rows=(Array.isArray(b.rows)?b.rows:[]).slice(0,200).map(r=>Array.isArray(r)?r.slice(0,cols.length).map(c=>txt(c,30)):null).filter(Boolean);
  if(!cols.length||!rows.length)return null;
  const d=el('details','tbl blk');if(!b.collapsed)d.open=true;
  d.appendChild(el('summary',null,(b.collapsed?'Show table: ':'')+txt(b.title||'Table',60)));
  const w=el('div','tw2'),t=document.createElement('table'),hd=document.createElement('tr');
  cols.forEach(c=>hd.appendChild(el('th',null,c)));t.appendChild(hd);
  rows.forEach(r=>{const tr=document.createElement('tr');r.forEach(c=>tr.appendChild(el('td',null,c)));t.appendChild(tr)});
  w.appendChild(t);d.appendChild(w);return d;
}
function renderBlocks(blocks){
  if(!Array.isArray(blocks)||!blocks.length)return null;
  const box=el('div','blks');
  blocks.slice(0,6).forEach(b=>{
    if(!b||typeof b!=='object')return;
    let node=null;
    try{
      if(b.type==='stats')node=statsBlock(b);
      else if(b.type==='table')node=tableBlock(b);
      else if(b.type==='chart'){
        if(b.kind==='donut'||b.kind==='pie')node=donutBlock(b);
        else if(b.kind==='bar')node=barBlock(b);
        else if(b.kind==='stacked')node=stackedBlock(b);
        else if(b.kind==='line')node=lineBlock(b,false);
        else if(b.kind==='area')node=lineBlock(b,true);
      }
    }catch(_){node=null}
    if(node)box.appendChild(node);
  });
  return box.children.length?box:null;
}

/* System 2 (rich charts) lives on the calculator project. Load it lazily; if anything fails the built-in blocks above stay. */
let vizP=null;
function loadViz(base){
  if(window.RupeyantraViz)return Promise.resolve(window.RupeyantraViz);
  if(vizP)return vizP;
  vizP=new Promise((ok,no)=>{const sc=document.createElement('script');sc.src=base+'viz.js';sc.async=true;const t=setTimeout(()=>no(new Error('slow')),5000);sc.onload=()=>{clearTimeout(t);window.RupeyantraViz?ok(window.RupeyantraViz):no(new Error('none'))};sc.onerror=()=>{clearTimeout(t);no(new Error('load'))};document.head.appendChild(sc)}).catch(e=>{vizP=null;throw e});
  return vizP;
}
function upgradeViz(bot,old,blocks,base){
  if(typeof base!=='string'||!/^https:\/\/[^\s]+\/system2\/$/.test(base))return;
  loadViz(base).then(V=>V.ready(blocks,base).then(()=>{
    if(!bot.isConnected)return;
    const box=el('div','blks');let n=0;
    blocks.slice(0,6).forEach(b=>{const node=V.render(b,{lang:'en',export:true});if(node){box.appendChild(node);n++}});
    if(!n)return;
    if(old&&old.parentNode===bot)bot.replaceChild(box,old);else bot.appendChild(box);
    bot._viz={V,base,blocks};
  })).catch(()=>{});
}


/* "Try different numbers": drag a slider, the SAME calculator runs again on the server (same checks) and the answer + charts update. */
function fmtSl(s,v){v=Number(v);return s.unit==='₹'?'₹'+v.toLocaleString('en-IN'):s.unit==='%'?v+'%':v+(s.unit||'')}
function mountSliders(bot,extra){
  const S=extra.sliders.filter(s=>s&&typeof s.key==='string'&&[s.min,s.max,s.step,s.value].every(isFinite)&&s.max>s.min&&s.step>0).slice(0,3);
  if(!S.length)return;
  const box=document.createElement('details');box.className='wi';box.open=true;
  const sm=document.createElement('summary');sm.textContent='Try different numbers';box.appendChild(sm);
  const status=document.createElement('div');status.className='wis';status.setAttribute('aria-live','polite');
  const ins={};let timer=null,seq=0,state=extra.state;
  S.forEach(s=>{
    const row=document.createElement('label');row.className='wir';
    const name=document.createElement('span');name.className='win';name.textContent=String(s.label||s.key).replace(/\s*\(.*?\)\s*$/,'').replace(/^the\s+/i,'').replace(/^./,c=>c.toUpperCase());
    const val=document.createElement('b');val.textContent=fmtSl(s,s.value);
    const r=document.createElement('input');r.type='range';r.min=s.min;r.max=s.max;r.step=s.step;r.value=s.value;r.setAttribute('aria-label',name.textContent);
    r.addEventListener('input',()=>{val.textContent=fmtSl(s,r.value);status.textContent='';clearTimeout(timer);timer=setTimeout(fire,350)});
    const top=document.createElement('div');top.className='wit';top.appendChild(name);top.appendChild(val);row.appendChild(top);row.appendChild(r);box.appendChild(row);ins[s.key]=r;
  });
  box.appendChild(status);bot.appendChild(box);
  async function fire(){
    const my=++seq,w={};S.forEach(s=>{w[s.key]=Number(ins[s.key].value)});
    status.textContent='Updating…';
    try{
      const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'what if'}],state,whatif:w}),signal:AbortSignal.timeout(15000)});
      const d=await r.json();
      if(my!==seq||!bot.isConnected)return;
      if(!r.ok||!d||typeof d.reply!=='string'||!d.reply||d.whatifFailed){status.textContent='Could not update right now. Please try again.';return}
      if(!d.state||!Array.isArray(d.blocks)){status.textContent=d.reply.slice(0,200);return}   // blocked or switched off: show why, keep old picture
      state=d.state;calcState=d.state;status.textContent='';
      const span=bot.firstChild;if(span&&span.tagName==='SPAN'){renderRich(span,d.reply);bot._text=d.reply}
      bot._am=Array.isArray(d.assumptions)?d.assumptions.filter(x=>typeof x==='string'):[];
      const old=bot.querySelector('.blks'),nb=renderBlocks(d.blocks);
      if(nb){if(old)bot.replaceChild(nb,old);else bot.insertBefore(nb,box);if(typeof d.viz==='string')upgradeViz(bot,nb,d.blocks,d.viz)}
      let v=bot.querySelector('.vf');if(d.verified===true&&!v){v=document.createElement('div');v.className='vf';v.textContent='✓ Verified by calculator';bot.insertBefore(v,box)}else if(d.verified!==true&&v)v.remove();
      const am=bot.querySelector('details.am');if(am){const ul=am.querySelector('ul');if(ul){ul.replaceChildren();bot._am.slice(0,8).forEach(x=>{const li=document.createElement('li');li.textContent=x.slice(0,300);ul.appendChild(li)})}}
      if(bot===lastBot&&convo.length&&convo[convo.length-1].role==='assistant')convo[convo.length-1].content=d.reply;
    }catch(_){if(my===seq)status.textContent='Could not update right now. Please try again.'}
  }
}

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
  d.appendChild(dot);d.appendChild(t);msgs.appendChild(d);down(true);return d;
}
function showError(bot,text,retryFn){
  bot.classList.remove('thinking');bot.classList.add('err');bot.textContent=text;
  const tools=document.createElement('div');tools.className='tools';
  const retry=mk(tools,'Try again',retryFn);retry.className='retry';
  bot.appendChild(tools);down();
}
function botMsg(bot,text,animate,extra){
  bot.classList.remove('thinking','err');bot.replaceChildren();
  const span=document.createElement('span');bot.appendChild(span);
  const tools=document.createElement('div');tools.className='tools';
  const finish=()=>{
    if(!bot.isConnected)return;
    renderRich(span,text);bot._text=text;bot._am=extra&&Array.isArray(extra.assumptions)?extra.assumptions.filter(x=>typeof x==='string'):[];
    if(extra&&extra.blocks){const bl=renderBlocks(extra.blocks);if(bl)bot.appendChild(bl);if(extra.viz)upgradeViz(bot,bl,extra.blocks,extra.viz)}
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
    mk(tools,'PDF',b=>{
      const z=bot._viz;
      if(!(z&&z.V&&z.V.exportPdf))return printEl(bot);
      const old=b.textContent;b.textContent='…';
      const nodes=Array.from(bot.querySelectorAll('.blks > *'));
      z.V.exportPdf({title:'Rupeyantra answer',text:bot._text||text,assumptions:bot._am||[],nodes}).then(blob=>z.V.saveBlob(blob,'rupeyantra-answer.pdf')).catch(()=>printEl(bot)).then(()=>{b.textContent=old});
    });
    mk(tools,'Share',b=>{
      const z=bot._viz,body=(bot._text||text)+'\n\n- Rupeyantra AI (https://rupyantra-psi.vercel.app/ai.html)';
      if(z&&z.V&&z.V.shareLink&&z.blocks&&z.blocks.length){
        z.V.shareLink({title:'Rupeyantra answer',reply:bot._text||text,blocks:z.blocks,base:z.base}).then(url=>{if(navigator.share)navigator.share({title:'Rupeyantra answer',url}).catch(()=>{});else copyText(url,b)}).catch(()=>{if(navigator.share)navigator.share({text:body}).catch(()=>{});else copyText(body,b)});
        return;
      }
      if(navigator.share)navigator.share({text:body}).catch(()=>{});else copyText(body,b)
    });
    const up=mk(tools,'👍',()=>{const o=up.getAttribute('aria-pressed')!=='true';up.setAttribute('aria-pressed',String(o));dn.setAttribute('aria-pressed','false');if(o)warn('Thanks for the feedback.')});
    const dn=mk(tools,'👎',()=>{const o=dn.getAttribute('aria-pressed')!=='true';dn.setAttribute('aria-pressed',String(o));up.setAttribute('aria-pressed','false');if(o)warn('Thanks for the feedback. Please check important figures yourself.')});
    up.setAttribute('aria-label','Good answer');dn.setAttribute('aria-label','Poor answer');up.setAttribute('aria-pressed','false');dn.setAttribute('aria-pressed','false');
    if(extra&&extra.verified){const v=document.createElement('div');v.className='vf';v.textContent='✓ Verified by calculator';bot.appendChild(v)}
    if(extra&&Array.isArray(extra.assumptions)){const al=extra.assumptions.filter(x=>typeof x==='string'&&x).slice(0,8);if(al.length){const dt=document.createElement('details');dt.className='am';const sm=document.createElement('summary');sm.textContent='How this was calculated';dt.appendChild(sm);const ul=document.createElement('ul');al.forEach(x=>{const li=document.createElement('li');li.textContent=x.slice(0,300);ul.appendChild(li)});dt.appendChild(ul);bot.appendChild(dt)}}
    if(extra&&Array.isArray(extra.sliders)&&extra.state&&extra.blocks)mountSliders(bot,extra);
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
  bot.remove();lastBot=null;send();
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
function loadImage(f){return new Promise((ok,no)=>{const u=URL.createObjectURL(f),im=new Image();const done=()=>URL.revokeObjectURL(u);im.onload=()=>{done();ok(im)};im.onerror=()=>{done();no(new Error('This photo format is not supported. Try a JPG or PNG'))};im.src=u})}
function drawScaled(im,max,q){
  const s=Math.min(1,max/Math.max(im.naturalWidth,im.naturalHeight));
  const w=Math.max(1,Math.round(im.naturalWidth*s)),h=Math.max(1,Math.round(im.naturalHeight*s));
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,w,h);x.drawImage(im,0,0,w,h);
  const out=c.toDataURL('image/jpeg',q);c.width=c.height=0;return out;
}
const b64Of=u=>u.split(',')[1]||'';
const pendingB64=()=>pending.reduce((n,p)=>n+(p.data?p.data.length:0),0);
const IMG_EXT=/\.(jpe?g|png|webp|gif|bmp|avif)$/i,MAX_IMG_FILE=30e6;
async function prepareImage(f){
  if(f.size>MAX_IMG_FILE)throw new Error('This photo is too large (max 30 MB)');
  const im=await loadImage(f);
  if(!im.naturalWidth||!im.naturalHeight)throw new Error('This photo could not be read');
  const room=Math.min(MAX_B64,MAX_TOTAL_B64-pendingB64());
  for(const [max,q] of [[1600,.82],[1280,.78],[1024,.72],[800,.65],[640,.6]]){
    const data=b64Of(drawScaled(im,max,q));
    if(data.length&&data.length<=room)return {kind:'image',name:f.name||'photo.jpg',mime:'image/jpeg',data,thumb:drawScaled(im,120,.7)};
  }
  throw new Error('This photo is too large for the space left. Remove an attachment or use a smaller photo');
}
async function preparePdf(f){
  if(f.size>MAX_PDF)throw new Error('PDF must be under 2 MB');
  const buf=await f.slice(0,5).arrayBuffer();
  if(String.fromCharCode(...new Uint8Array(buf))!=='%PDF-')throw new Error('This does not look like a valid PDF');
  const data=b64Of(await readDataURL(f));
  if(!data)throw new Error('This PDF is empty');
  if(data.length>MAX_TOTAL_B64-pendingB64())throw new Error('Not enough space left for this PDF. Remove an attachment first');
  return {kind:'pdf',name:f.name||'file.pdf',mime:'application/pdf',data,thumb:null};
}
async function prepareText(f){
  if(f.size>MAX_TEXT_FILE)throw new Error('Text file is too large (max 500 KB)');
  const text=(await readText(f)).replace(/\u0000/g,'').trim();
  if(!text)throw new Error('File is empty');
  return {kind:'text',name:f.name||'file.txt',text:text.slice(0,TEXT_PER_FILE),thumb:null};
}
let adding=false;
async function addFiles(files){
  if(adding){warn('Please wait, the previous file is still loading.');return}
  adding=true;form.classList.add('loading');
  try{
    for(const f of files){
      if(pending.length>=MAX_FILES){warn('You can attach up to '+MAX_FILES+' files at a time.');break}
      if(pending.some(p=>p.name===f.name&&p.size===f.size)){warn(f.name+' is already attached.');continue}
      try{
        let item;
        const isPdf=f.type==='application/pdf'||/\.pdf$/i.test(f.name);
        if(isPdf)item=await preparePdf(f);
        else if(f.type.startsWith('image/')||IMG_EXT.test(f.name))item=await prepareImage(f);
        else if(f.type.startsWith('text/')||f.type==='application/json'||TEXT_EXT.test(f.name))item=await prepareText(f);
        else throw new Error('Unsupported file type. Send a photo, PDF or text/CSV file');
        item.size=f.size;pending.push(item);
      }catch(e){warn((f.name?f.name+': ':'')+(e.message||'Could not attach the file'))}
    }
  }finally{adding=false;form.classList.remove('loading');renderChips()}
}
function renderChips(){
  chips.replaceChildren();
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
  const paint=()=>{raf=0;if(!bot.isConnected||my!==gen)return;if(!span){bot.classList.remove('thinking','err');bot.replaceChildren();span=document.createElement('span');bot.appendChild(span)}renderRich(span,acc);down()};
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
function friendly(status){
  if(status===429)return 'Too many requests right now. Please wait a minute and try again.';
  if(status===413)return 'That message or file is too large. Please shorten it and try again.';
  if(status===401||status===403)return 'This request was not allowed. Please refresh the page and try again.';
  if(status===404)return 'The assistant is not available at the moment. Please try again later.';
  if(status>=500)return 'The assistant is busy or restarting. Please try again in about 30 seconds.';
  return 'No response right now. Please try again.';
}
let calcState=null;
async function send(){
  const my=++gen;
  stopped=false;
  controller=new AbortController();
  const bot=thinkingBot();activeBot=bot;setBusy(true);
  let timedOut=false,serverData={};
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},REQUEST_TIMEOUT);
  try{
    const last=convo.length-1;
    const payload=convo.map((m,i)=>{const o={role:m.role,content:m.content};if(i===last&&m.attachments)o.attachments=m.attachments;return o});
    const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json','Accept':'text/event-stream, application/json;q=0.9'},body:JSON.stringify(Object.assign(SID?{messages:payload,sessionId:SID}:{messages:payload},calcState?{state:calcState}:{})),signal:controller.signal});
    let reply='',streamed=false;
    if(r.ok&&r.body&&(r.headers.get('content-type')||'').includes('text/event-stream')){
      streamed=true;
      reply=await readStream(r,bot,my);
      serverData=streamMeta;
    }else{
      try{serverData=await r.json()}catch(_){}
      reply=serverData&&typeof serverData.reply==='string'?serverData.reply.trim():'';
      if(!r.ok||!reply){
        const e=new Error((serverData&&serverData.message)||friendly(r.status));
        e.fromServer=true;throw e;
      }
    }
    if(my!==gen)return;
    if(!reply){const e=new Error('No response right now. Please try again.');e.fromServer=true;throw e}
    setBusy(false);
    lastUserEl=null;
    convo.push({role:'assistant',content:reply});
    log.push({role:'bot',text:reply});
    
    lastBot=bot;
    calcState=serverData&&serverData.state&&typeof serverData.state==='object'?serverData.state:null;
    botMsg(bot,reply,!streamed,{verified:serverData.verified===true,sliders:serverData.sliders,state:serverData.state,options:serverData.options,assumptions:serverData.assumptions,blocks:serverData.blocks,viz:serverData.viz});
    if(voiceOn)vSpeak(reply);
  }catch(e){
    if(stopped||my!==gen)return;
    let msg=e&&e.fromServer?e.message:timedOut?'The response is taking too long. Please try again in a moment.':(navigator.onLine===false?'You seem to be offline. Please check your internet connection and try again.':'Could not reach the server. Please check your connection and try again.');
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
  if(adding){warn('Please wait, your file is still loading.');return}
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
    grow();
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

/* voice language (English / Hindi) */
function voiceLang(){try{return localStorage.getItem('rupeyantra_voice')==='hi'?'hi-IN':'en-IN'}catch(_){return 'en-IN'}}
function syncLang(){const t=$('langtxt');if(t)t.textContent='Voice language: '+(voiceLang()==='hi-IN'?'Hindi':'English')}
$('pickLang').onclick=e=>{e.stopPropagation();try{localStorage.setItem('rupeyantra_voice',voiceLang()==='hi-IN'?'en':'hi')}catch(_){}syncLang()};
syncLang();

/* scroll to latest */
(function(){
  const b=$('toBottom'),dock=$('dock');
  function place(){b.style.bottom=(dock.offsetHeight+12)+'px'}
  function check(){place();b.hidden=!(msgs.scrollHeight-msgs.scrollTop-msgs.clientHeight>180)}
  msgs.addEventListener('scroll',check,{passive:true});
  window.addEventListener('resize',check);
  new MutationObserver(check).observe(msgs,{childList:true,subtree:true,characterData:true});
  b.onclick=()=>{msgs.scrollTop=msgs.scrollHeight};
  place();
})();

/* new chat */
function resetView(){
  stopped=true;gen++;
  if(controller)controller.abort();
  if(rec){try{rec.stop()}catch(_){}}
  stopSpeech();speaking=null;
  if(voiceOn)$('vx').onclick();
  convo=[];log=[];pending=[];activeBot=null;lastUserEl=null;lastBot=null;genRun=false;setGen(null);
  msgs.replaceChildren();
  app.classList.remove('chatting');
  setBusy(false);renderChips();inp.value='';grow();
}
let newChatBusy=false;
function newChat(){
  if(newChatBusy)return;
  const btn=$('newChat'),wel=$('welcome');
  btn.classList.remove('spin');void btn.offsetWidth;btn.classList.add('spin');
  if(!log.length&&!msgs.children.length){wel.classList.remove('enter');void wel.offsetWidth;wel.classList.add('enter');inp.focus();return}
  const go=()=>{
    resetView();rotateSid();
    msgs.classList.remove('leaving');
    wel.classList.remove('enter');void wel.offsetWidth;wel.classList.add('enter');
    newChatBusy=false;inp.focus();
  };
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion:reduce)').matches){go();return}
  newChatBusy=true;
  msgs.classList.add('leaving');
  setTimeout(go,280);
}
$('newChat').onclick=newChat;

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
    r.lang=voiceLang();r.interimResults=false;r.continuous=false;
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
  const r=new SR();r.lang=voiceLang();r.interimResults=true;r.continuous=false;
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

/* About & FAQ: ek baar dabao to khule, dobara dabao to band (animation ke saath) */
(function(){
  const ab=$('about'),strip=document.querySelector('.strip'),links=document.querySelectorAll('a[href="#about"]');
  function place(){ab.style.top=(strip.getBoundingClientRect().bottom+6)+'px'}
  function setAbout(o){
    if(o){place();ab.scrollTop=0}
    ab.classList.toggle('show',o);ab.setAttribute('aria-hidden',String(!o));
    links.forEach(a=>a.setAttribute('aria-expanded',String(o)));
  }
  links.forEach(a=>a.addEventListener('click',e=>{e.preventDefault();setAbout(!ab.classList.contains('show'))}));
  document.querySelectorAll('a[href="#app"]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();setAbout(false);inp.focus({preventScroll:true})}));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&ab.classList.contains('show'))setAbout(false)});
  window.addEventListener('resize',()=>{if(ab.classList.contains('show'))place()});
})();

/* disclaimer button: the long text opens only when asked */
(function(){
  const btn=$('discBtn'),panel=$('discPanel');
  const set=o=>{
    btn.setAttribute('aria-expanded',String(o));
    if(o){panel.classList.remove('closing');panel.hidden=false;panel.scrollIntoView({block:'nearest'});$('discClose').focus();return}
    if(panel.hidden)return;
    const done=()=>{panel.hidden=true;panel.classList.remove('closing');btn.focus()};
    if(window.matchMedia&&matchMedia('(prefers-reduced-motion:reduce)').matches){done();return}
    panel.classList.add('closing');setTimeout(done,190);
  };
  btn.onclick=()=>set(panel.hidden);
  $('discClose').onclick=()=>set(false);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden)set(false)});
})();

grow();
inp.placeholder=PLACEHOLDER;
})();
