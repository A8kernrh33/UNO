import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';

const app = express();
const http = createServer(app);
const wss = new WebSocketServer({ server: http });
const rooms = new Map();
const PORT = Number(process.env.PORT || 10000);
const COLORS = ['red','yellow','green','blue'];
const ACTIONS = ['skip','reverse','draw2'];

app.use(express.static('public', { extensions: ['html'] }));
app.get('/health', (_req,res)=>res.json({ok:true,rooms:rooms.size}));
app.get('*', (_req,res)=>res.sendFile(process.cwd() + '/public/index.html'));

const id = () => crypto.randomBytes(4).toString('hex');
const code = () => { let c; do c=Math.random().toString(36).slice(2,8).toUpperCase(); while(rooms.has(c)); return c; };
const send = (ws,msg) => ws.readyState===1 && ws.send(JSON.stringify(msg));
const broadcast = (room,msg) => room.players.forEach(p=>send(p.ws,msg));
const publicState = room => ({
  room: room.code, host: room.host, started: room.started, direction: room.direction,
  turn: room.players[room.turn]?.id || null, color: room.color,
  discard: room.discard.at(-1), deckCount: room.deck.length,
  players: room.players.map(p=>({id:p.id,name:p.name,ready:p.ready,count:p.hand.length,connected:!!p.ws})),
  winner: room.winner || null, message: room.message || null,
  pendingChallenge: room.pendingChallenge ? {by:room.pendingChallenge.by, expires:room.pendingChallenge.expires} : null
});
function stateFor(room,p){
  const s=publicState(room); s.me=p.id; s.hand=p.hand; return s;
}
function emit(room,kind,extra={}) { broadcast(room,{type:kind,state:publicState(room),...extra}); }
function log(room,text){ room.log.unshift({text,at:Date.now()}); room.log=room.log.slice(0,60); }
function makeDeck(){
  const d=[];
  for(const c of COLORS){ d.push({c,n:'0',uid:id()}); for(let n=1;n<=9;n++) for(let i=0;i<2;i++) d.push({c,n:String(n),uid:id()}); for(const n of ACTIONS) for(let i=0;i<2;i++) d.push({c,n,uid:id()}); }
  for(let i=0;i<4;i++){d.push({c:'wild',n:'wild',uid:id()});d.push({c:'wild',n:'wild4',uid:id()});}
  return d;
}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a;}
function refill(room){if(room.deck.length) return; const top=room.discard.pop(); room.deck=shuffle(room.discard.splice(0)); room.discard=[top];}
function draw(room,n){const out=[];for(let i=0;i<n;i++){refill(room);if(!room.deck.length) break;out.push(room.deck.pop())}return out;}
function nextIndex(room,steps=1){let i=room.turn;for(let k=0;k<steps;k++) i=(i+room.direction+room.players.length)%room.players.length;return i;}
function hasColor(hand,color){return hand.some(c=>c.c===color);}
function canPlay(room,card){const top=room.discard.at(-1);return card.c==='wild'||card.c===room.color||card.n===top.n;}
function validWild4(room,p,card){return card.n!=='wild4'||!hasColor(p.hand,room.color);}
function deal(room){room.deck=shuffle(makeDeck());room.players.forEach(p=>p.hand=draw(room,7)); let first; do{first=draw(room,1)[0]; if(first.c==='wild4'){room.deck.unshift(first);first=null}}while(!first); room.discard=[first]; room.color=first.c==='wild'?'red':first.c; room.turn=0; room.direction=1; room.pendingChallenge=null; room.started=true; room.winner=null; room.message='Game started';
  // Apply the opening action according to standard table play.
  if(first.n==='reverse') room.direction=-1;
  if(first.n==='skip') room.turn=nextIndex(room);
  if(first.n==='draw2'){const p=room.players[0];p.hand.push(...draw(room,2));room.turn=nextIndex(room);}
}
function finishRound(room,winner){room.winner=winner.id;room.started=false;const points=room.players.reduce((sum,p)=>sum+(p.id===winner.id?0:p.hand.reduce((s,c)=>s+(c.c==='wild'?50:ACTIONS.includes(c.n)?20:Number(c.n)||0),0)),0);room.message=`${winner.name} wins the round · ${points} points`;log(room,`🏆 ${winner.name} wins the round for ${points} points`);emit(room,'state');}
function play(room,p,index,color){
  if(!room.started||room.pendingChallenge)return;
  const pi=room.players.indexOf(p); if(pi!==room.turn) return send(p.ws,{type:'error',message:'It is not your turn.'});
  const card=p.hand[index]; if(!card)return;
  if(!canPlay(room,card))return send(p.ws,{type:'error',message:'That card cannot be played now.'});
  if(!validWild4(room,p,card))return send(p.ws,{type:'error',message:'You can only play Wild +4 when you have no card matching the current color.'});
  p.hand.splice(index,1); room.discard.push(card); if(card.c==='wild') room.color=color; else room.color=card.c;
  room.message=`${p.name} played ${label(card)}`; log(room,`${p.name} played ${label(card)}`);
  if(p.hand.length===0)return finishRound(room,p);
  if(p.hand.length===1){room.unoWindow={player:p.id,called:false,expires:Date.now()+2500}; log(room,`🔴 ${p.name} is on UNO`);}
  let skip=card.n==='skip'; if(card.n==='reverse' && room.players.length===2) skip=true;
  if(card.n==='draw2'){room.turn=nextIndex(room); const victim=room.players[room.turn];victim.hand.push(...draw(room,2));room.message=`${victim.name} draws 2`; room.turn=nextIndex(room);}
  else room.turn=nextIndex(room,skip?2:1);
  if(card.n==='wild4') room.pendingChallenge={by:p.id,expires:Date.now()+3500,previousColor:room.color,hadColor:hasColor(p.hand, room.discard.at(-1).c)};
  emit(room,'state');
}
function label(c){return c.n==='draw2'?'+2':c.n==='wild4'?'Wild +4':c.n==='wild'?'Wild':c.n==='reverse'?'Reverse':c.n==='skip'?'Skip':c.n;}
function action(room,p,a){
  const idx=room.players.indexOf(p); if(a==='ready'){p.ready=!!p.ready;emit(room,'lobby');return;}
  if(a==='start'){if(p.id!==room.host)return;if(room.players.length<2)return send(p.ws,{type:'error',message:'Need at least 2 players.'});if(!room.players.every(x=>x.ready))return send(p.ws,{type:'error',message:'Everyone must be Ready.'});deal(room);log(room,'🎴 New round started');emit(room,'state');return;}
  if(a==='newround'){if(p.id!==room.host)return;if(room.players.length<2)return;deal(room);emit(room,'state');return;}
  if(a==='play')return play(room,p,a.index,a.color);
  if(a==='draw'){if(idx!==room.turn||!room.started)return; if(room.pendingChallenge)return send(p.ws,{type:'error',message:'Resolve the Wild +4 challenge first.'}); const cards=draw(room,1);p.hand.push(...cards);room.message=`${p.name} drew ${cards.length}`;log(room,`${p.name} drew a card`);p.drew=true;emit(room,'state');return;}
  if(a==='pass'){if(idx!==room.turn||!p.drew)return; p.drew=false;room.turn=nextIndex(room);emit(room,'state');return;}
  if(a==='uno'){if(room.unoWindow?.player===p.id){room.unoWindow.called=true;log(room,`📣 ${p.name} called UNO`);emit(room,'state')}return;}
  if(a==='challenge'){const pc=room.pendingChallenge;if(!pc||Date.now()>pc.expires||pc.by===p.id)return; const offender=room.players.find(x=>x.id===pc.by); room.pendingChallenge=null; if(pc.hadColor){offender.hand.push(...draw(room,4));room.turn=nextIndex(room);room.message=`Challenge successful · ${offender.name} draws 4`;log(room,`⚖️ Wild +4 challenge succeeded`);}else{p.hand.push(...draw(room,6));room.message=`Challenge failed · ${p.name} draws 6`;log(room,`⚖️ Wild +4 challenge failed`);} emit(room,'state');return;}
}
function createRoom(name,ws){const r={code:code(),host:'',players:[],started:false,direction:1,turn:0,color:'red',deck:[],discard:[],winner:null,message:'Waiting for players',pendingChallenge:null,log:[]};const p={id:id(),name:name.slice(0,18)||'Player',ws,hand:[],ready:false,drew:false};r.host=p.id;p.ready=true;r.players.push(p);rooms.set(r.code,r);return [r,p];}
function joinRoom(room,name,ws){if(!room||room.started)return null;if(room.players.length>=8)return null;const p={id:id(),name:name.slice(0,18)||'Player',ws,hand:[],ready:false,drew:false};room.players.push(p);return p;}
function sendState(room){room.players.forEach(p=>send(p.ws,{type:'state',state:stateFor(room,p),log:room.log}));}
function cleanup(room,p){p.ws=null;if(room.started){log(room,`⚠️ ${p.name} disconnected`);emit(room,'state');}else{room.players=room.players.filter(x=>x.id!==p.id);if(p.id===room.host)room.host=room.players[0]?.id||'';if(!room.players.length)rooms.delete(room.code);else emit(room,'lobby');}}

wss.on('connection',ws=>{
  let room=null,p=null;
  ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return};
    if(m.type==='create'){[room,p]=createRoom(String(m.name||'Player'),ws);send(ws,{type:'joined',state:stateFor(room,p),log:room.log});emit(room,'lobby');return;}
    if(m.type==='join'){room=rooms.get(String(m.code||'').toUpperCase());p=joinRoom(room,String(m.name||'Player'),ws);if(!p)return send(ws,{type:'error',message:'Room not found, full, or already started.'});send(ws,{type:'joined',state:stateFor(room,p),log:room.log});emit(room,'lobby');return;}
    if(!room||!p)return;
    if(m.type==='action')action(room,p,m.action);
  });
  ws.on('close',()=>{if(room&&p)cleanup(room,p)});
});
setInterval(()=>{for(const room of rooms.values()){if(room.unoWindow&&Date.now()>room.unoWindow.expires){const u=room.unoWindow;const p=room.players.find(x=>x.id===u.player);if(p&&!u.called&&p.hand.length===1){p.hand.push(...draw(room,2));log(room,`⚠️ ${p.name} missed UNO and draws 2`)}room.unoWindow=null;emit(room,'state')}if(room.pendingChallenge&&Date.now()>room.pendingChallenge.expires){room.pendingChallenge=null;emit(room,'state')}}},500);
process.on('SIGTERM',()=>{wss.clients.forEach(ws=>ws.close(1001,'Server restarting'));http.close(()=>process.exit(0));});
http.listen(PORT,'0.0.0.0',()=>console.log(`UNO server listening on ${PORT}`));
