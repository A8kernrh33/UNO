import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';

const app = express();
const http = createServer(app);
const wss = new WebSocketServer({ server: http });
const rooms = new Map();
const PORT = Number(process.env.PORT || 10000);
const COLORS = ['red','yellow','green','blue'];
const ACTIONS = ['skip','reverse','draw2'];
const MAX_PLAYERS = 8;

const MOTION_STYLE = Buffer.from('HJ0OlCM=', 'base64').toString();
const MOTION_SCRIPT = Buffer.from('HJ0OlCM=', 'base64').toString();
let INDEX_HTML = '';
try {
  INDEX_HTML = fs.readFileSync(process.cwd() + '/public/index.html', 'utf8');
  INDEX_HTML = INDEX_HTML
    .replace('</head>', `<style id="premium-card-motion">${MOTION_STYLE}</style></head>`)
    .replace('</body>', `<script id="premium-card-motion-script">${MOTION_SCRIPT}</script></body>`);
} catch {}

app.get('/', (_, res) => res.type('html').send(INDEX_HTML));
app.use(express.static('public'));
app.get('/health', (_, res) => res.json({ ok:true, rooms:rooms.size }));

const id = () => crypto.randomBytes(5).toString('hex');
const send = (ws, msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
const shuffle = a => { for (let i=a.length-1;i;i--) { const j=Math.floor(Math.random()* (i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
const cleanName = n => String(n || 'Player').replace(/[<>]/g,'').trim().slice(0,18) || 'Player';
const cleanText = t => String(t ?? '').replace(/[<>]/g,'').replace(/\s+/g,' ').trim().slice(0,180);

function deck(){
  const d=[];
  for(const c of COLORS){
    d.push({c,n:'0',u:id()});
    for(let n=1;n<10;n++) for(let i=0;i<2;i++) d.push({c,n:String(n),u:id()});
    for(const n of ACTIONS) for(let i=0;i<2;i++) d.push({c,n,u:id()});
  }
  for(let i=0;i<4;i++) d.push({c:'wild',n:'wild',u:id()},{c:'wild',n:'wild4',u:id()});
  return shuffle(d);
}
function refill(r){
  if(r.d.length) return;
  if(r.dis.length <= 1) return;
  const top=r.dis.pop();
  r.d=shuffle(r.dis.splice(0));
  r.dis=[top];
}
function draw(r,n){const out=[];while(n--){refill(r);if(r.d.length)out.push(r.d.pop());}return out;}
function next(r,steps=1){let i=r.turn;while(steps--)i=(i+r.dir+r.ps.length)%r.ps.length;return i;}
function label(c){return c.n==='draw2'?'+2':c.n==='wild4'?'Wild +4':c.n==='wild'?'Wild':c.n==='reverse'?'Reverse':c.n==='skip'?'Skip':c.n;}
function log(r,text){r.log.unshift({text,at:Date.now()});r.log=r.log.slice(0,80);}
function publicState(r){return {room:r.code,host:r.host,started:r.started,turn:r.ps[r.turn]?.id||null,direction:r.dir,color:r.color,discard:r.dis.at(-1),deckCount:r.d.length,players:r.ps.map(p=>({id:p.id,name:p.name,ready:p.ready,count:p.h.length,connected:!!p.ws})),winner:r.winner,message:r.message,pendingChallenge:r.challenge?{by:r.challenge.by,expires:r.challenge.expires}:null,chat:r.chat.slice(-80)};}
function push(r,kind='state'){for(const p of r.ps)send(p.ws,{type:kind,state:{...publicState(r),me:p.id,hand:p.h},log:r.log});}
function chat(r,p,text){
  const now=Date.now();
  if(now-p.lastChat<500) return send(p.ws,{type:'error',message:'Slow down a little.'});
  const t=cleanText(text); if(!t) return;
  p.lastChat=now;
  r.chat.push({id:id(),player:p.id,name:p.name,text:t,at:now});
  r.chat=r.chat.slice(-80);
  push(r,'chat');
}
function makeRoom(name,ws){
  const r={code:'',host:'',ps:[],started:false,dir:1,turn:0,color:'red',d:[],dis:[],winner:null,message:'Waiting for players',challenge:null,log:[],chat:[]};
  do r.code=Math.random().toString(36).slice(2,8).toUpperCase(); while(rooms.has(r.code));
  const p={id:id(),name:cleanName(name),ws,h:[],ready:true,drew:false,unoUntil:0,unoCalled:false,lastChat:0,lastTyping:0};
  r.host=p.id;r.ps=[p];rooms.set(r.code,r);return[r,p];
}
function start(r){
  r.d=deck();r.dis=[];r.ps.forEach(p=>{p.h=[];p.drew=false;p.unoUntil=0;p.unoCalled=false;});
  for(let i=0;i<7;i++)for(const p of r.ps)p.h.push(r.d.pop());
  let top;do{top=r.d.pop();if(top.c==='wild4')r.d.unshift(top),top=null;}while(!top);
  r.dis=[top];r.color=top.c==='wild'?'red':top.c;r.dir=1;r.turn=0;r.challenge=null;r.winner=null;r.started=true;r.message='Game started';
  if(top.n==='reverse')r.dir=-1;if(top.n==='skip')r.turn=next(r);if(top.n==='draw2'){r.ps[0].h.push(...draw(r,2));r.turn=next(r);}
  log(r,'🎴 New round started');push(r);
}
function legal(r,p,c){return !!c&&(c.c==='wild'||c.c===r.color||c.n===r.dis.at(-1).n)&&(c.n!=='wild4'||!p.h.some(x=>x.c===r.color));}
function play(r,p,index,color){
  if(!r.started||r.challenge)return;
  if(r.ps[r.turn]!==p)return send(p.ws,{type:'error',message:'It is not your turn.'});
  const c=p.h[index];if(!legal(r,p,c))return send(p.ws,{type:'error',message:'That card cannot be played.'});
  if(c.c==='wild'&&!COLORS.includes(color))return send(p.ws,{type:'error',message:'Choose a color.'});
  const previousColor=r.color;
  p.h.splice(index,1);r.dis.push(c);r.color=c.c==='wild'?color:c.c;
  log(r,`${p.name} played ${label(c)}`);r.message=`${p.name} played ${label(c)}`;
  if(!p.h.length){
    r.started=false;r.winner=p.id;
    const pts=r.ps.reduce((s,x)=>s+(x.id===p.id?0:x.h.reduce((q,z)=>q+(z.c==='wild'?50:ACTIONS.includes(z.n)?20:Number(z.n)||0),0)),0);
    r.message=`${p.name} wins · ${pts} points`;log(r,`🏆 ${p.name} wins the round`);return push(r);
  }
  if(p.h.length===1){p.unoUntil=Date.now()+3500;p.unoCalled=false;log(r,`🔴 ${p.name} is on UNO`);}
  const skip=c.n==='skip'||(c.n==='reverse'&&r.ps.length===2);if(c.n==='reverse')r.dir*=-1;
  if(c.n==='draw2'){r.turn=next(r);const v=r.ps[r.turn];v.h.push(...draw(r,2));log(r,`${v.name} draws 2`);r.turn=next(r);}else r.turn=next(r,skip?2:1);
  if(c.n==='wild4')r.challenge={by:p.id,expires:Date.now()+6000,hadColor:p.h.some(x=>x.c===previousColor)};
  push(r);
}
function act(r,p,a){
  const i=r.ps.indexOf(p);
  if(a==='ready'){if(r.started)return;p.ready=!p.ready;return push(r,'lobby');}
  if(a==='start'){if(p.id!==r.host)return;if(r.ps.length<2)return send(p.ws,{type:'error',message:'Need at least 2 players.'});if(!r.ps.every(x=>x.ready))return send(p.ws,{type:'error',message:'Everyone must be ready.'});return start(r);}
  if(a==='newround'){if(p.id===r.host&&r.ps.length>1)return start(r);return;}
  if(a?.a==='chat')return chat(r,p,a.text);
  if(a?.a==='typing'){if(Date.now()-p.lastTyping<700)return;p.lastTyping=Date.now();for(const q of r.ps)if(q!==p)send(q.ws,{type:'typing',player:p.id,name:p.name});return;}
  if(a?.a==='play')return play(r,p,a.index,a.color);
  if(a?.a==='draw4'){if(i!==r.turn||!r.challenge)return;const v=r.ps[r.turn];v.h.push(...draw(r,4));r.challenge=null;r.message=`${v.name} takes +4`;log(r,`${v.name} takes +4 and loses the turn`);r.turn=next(r);return push(r);}
  if(a?.a==='draw'){if(i!==r.turn||!r.started)return;if(r.challenge){const v=r.ps[r.turn];v.h.push(...draw(r,4));r.challenge=null;r.message=`${v.name} takes +4`;log(r,`${v.name} takes +4 and loses the turn`);r.turn=next(r);return push(r);}const x=draw(r,1);p.h.push(...x);p.drew=true;log(r,`${p.name} drew a card`);return push(r);}
  if(a?.a==='pass'){if(i!==r.turn||!p.drew)return;p.drew=false;r.turn=next(r);return push(r);}
  if(a?.a==='uno'){if(p.unoUntil&&Date.now()<=p.unoUntil&&p.h.length===1){p.unoCalled=true;log(r,`📣 ${p.name} called UNO`);push(r);}return;}
  if(a?.a==='catch'){const target=r.ps.find(x=>x.unoUntil&&x.id!==p.id);if(target&&Date.now()<=target.unoUntil&&target.h.length===1&&!target.unoCalled){target.h.push(...draw(r,2));target.unoUntil=0;log(r,`⚠️ ${p.name} caught ${target.name} without UNO`);push(r);}return;}
  if(a?.a==='challenge'){const q=r.challenge;if(!q||Date.now()>q.expires||q.by===p.id||p.id!==r.ps[r.turn]?.id)return;r.challenge=null;const offender=r.ps.find(x=>x.id===q.by);if(q.hadColor){offender.h.push(...draw(r,4));r.message=`Challenge succeeded · ${offender.name} draws 4`;log(r,'⚖️ Wild +4 challenge succeeded');}else{p.h.push(...draw(r,6));r.message=`Challenge failed · ${p.name} draws 6`;log(r,'⚖️ Wild +4 challenge failed');}r.turn=next(r);push(r);}
}
function clean(r,p){p.ws=null;if(!r.started){r.ps=r.ps.filter(x=>x!==p);if(p.id===r.host)r.host=r.ps[0]?.id||'';if(!r.ps.length)rooms.delete(r.code);else push(r,'lobby');}else{log(r,`⚠️ ${p.name} disconnected`);push(r);}}
wss.on('connection',ws=>{
  let r=null,p=null;
  ws.on('message',b=>{let m;try{m=JSON.parse(b);}catch{return;}
    if(m.type==='create'){[r,p]=makeRoom(m.name,ws);send(ws,{type:'joined',state:{...publicState(r),me:p.id,hand:p.h},log:r.log});push(r,'lobby');return;}
    if(m.type==='join'){r=rooms.get(String(m.code||'').toUpperCase());if(!r||r.started||r.ps.length>=MAX_PLAYERS)return send(ws,{type:'error',message:'Room not found, full, or already started.'});p={id:id(),name:cleanName(m.name),ws,h:[],ready:false,drew:false,unoUntil:0,unoCalled:false,lastChat:0,lastTyping:0};r.ps.push(p);send(ws,{type:'joined',state:{...publicState(r),me:p.id,hand:p.h},log:r.log});return push(r,'lobby');}
    if(r&&p&&m.type==='action')act(r,p,m.action);
  });
  ws.on('close',()=>r&&p&&clean(r,p));
});
setInterval(()=>{
  for(const r of rooms.values()){
    for(const p of r.ps)if(p.unoUntil&&Date.now()>p.unoUntil&&!p.unoCalled){if(p.h.length===1){p.h.push(...draw(r,2));log(r,`⚠️ ${p.name} missed UNO and draws 2`);}p.unoUntil=0;push(r);}
    if(r.challenge&&Date.now()>r.challenge.expires){const v=r.ps[r.turn];r.challenge=null;if(v&&r.started){v.h.push(...draw(r,4));r.message=`${v.name} takes +4`;log(r,`${v.name} takes +4 and loses the turn`);r.turn=next(r);push(r);}}
  }
},500);
process.on('SIGTERM',()=>{wss.clients.forEach(w=>w.close(1001));http.close(()=>process.exit(0));});
http.listen(PORT,'0.0.0.0',()=>console.log(`UNO listening on ${PORT}`));
