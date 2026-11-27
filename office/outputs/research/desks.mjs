import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from '../../work/office/node_modules/ws/wrapper.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const read=name=>JSON.parse(fs.readFileSync(path.join(here,'.agent-office',name),'utf8'));
const origin='http://127.0.0.1:4600';
const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({password:read('config.json').password})});
if(!login.ok) throw new Error('Office login failed '+login.status);
const socket=new WebSocket('ws://127.0.0.1:4600/ws?floor=research&name=Research&lite=1',{origin,headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}});
const roles=['Planner','Researcher','Reviewer','Politics','Global health'];
const send=m=>socket.send(JSON.stringify(m));
const initialized=new Set();
socket.on('message',raw=>{
 const m=JSON.parse(raw);
 if(m.t==='welcome'){
   for(const w of m.workers||[]) observe(w);
   const existing=new Set((m.workers||[]).map(w=>w.deskId));
   roles.forEach((_,i)=>{if(!existing.has('desk-'+(i+1))) send({t:'worker.spawn',deskId:'desk-'+(i+1),kind:'shell'})});
 }
 if(m.t==='worker.update') observe(m.worker);
 if(m.t==='error')console.error(m.message);
});
function observe(w){
 if(w.kind==='shell' && !initialized.has(w.id)){
   const role=roles[Number(w.deskId.split('-')[1])-1];
   if(!role)return;
   initialized.add(w.id);
   send({t:'worker.attach',workerId:w.id});
   setTimeout(()=>{const file=path.resolve(here,'../../work',role+'.log');send({t:'term.input',workerId:w.id,data:"printf '\\n"+role+" · live activity\\n'; tail -n 10 -f '"+file.replaceAll("'","'\\''")+"'\r"});console.log(role,w.id);},1200);
 }
 }
setTimeout(()=>socket.close(),8000);
