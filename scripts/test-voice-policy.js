'use strict';
// Offline behavioral tests. Usage: node --test /private/tmp/bhatbot-voice-policy.test.cjs
// BHATBOT_VOICE_TEST_ROOT may point to an applied checkout; default is the temporary staged copy.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=process.env.BHATBOT_VOICE_TEST_ROOT || path.join(__dirname,'..');
const JARVIS='nuIFNGEZkRGoYBg8iBYe';
const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
const main=read('main.js');
function extract(source,name){
 const match=new RegExp('^(?:async )?function '+name+'\\(','m').exec(source); assert.ok(match,'missing '+name);
 const first=source.slice(match.index).split('\n')[0];
 return first.endsWith('}') ? first : source.slice(match.index,source.indexOf('\n}',match.index)+2);
}
function desktop(config={},extra={},names=['synthesizeSpeech']){
 const calls=[];
 const c={loadConfig:()=>config,normalizeForSpeech:t=>t.trim(),humanizeCadence:t=>t,Buffer,Date,Math,Number,String,console:{warn(){},error(){}},
  elevenLabsSynth:async(t,c,opts)=>{calls.push({t,c,opts});return {success:true,audio:'YQ==',via:'elevenlabs'};},
  kokoroAvailable:()=>true,kokoroSynth:()=>assert.fail('Kokoro called'),openaiSynth:()=>assert.fail('OpenAI called'),spawn:()=>assert.fail('alternate player called'),
  elLimit:fn=>fn(),_elDeadUntil:0,...extra};
 vm.createContext(c); vm.runInContext(names.map(n=>extract(main,n)).join('\n'),c);
 return {c,calls};
}
test('legacy/default provider settings all synthesize only through ElevenLabs',async()=>{
 for(const provider of [undefined,'kokoro','piper','openai','elevenlabs']){
  const {c,calls}=desktop({ttsProvider:provider,ttsStrict:false});
  assert.equal((await c.synthesizeSpeech('Hello',{previousText:'Before',nextText:'After',voice:'bm_george'})).via,'elevenlabs');
  assert.equal(calls.length,1);assert.equal(calls[0].opts.previousText,'Before');assert.equal(calls[0].opts.nextText,'After');
 }
});
test('ElevenLabs failures and thrown network errors never call alternate providers',async()=>{
 for(const synth of [async()=>({error:'quota',status:429}),async()=>{throw Error('network');}]){
  const {c}=desktop({ttsStrict:false,openaiKey:'fake'}, {elevenLabsSynth:synth});
  assert.ok((await c.synthesizeSpeech('Hello')).error);
 }
});
test('REST MP3 and phone ulaw use selected voice, flash, formats, and request stitching',async()=>{
 for(const config of [{elevenLabsKey:'fake'},{elevenLabsKey:'fake',ttsVoice:'ABCDEFGHIJKLMNOPQRST',elevenLabsVoiceId:JARVIS}]){
  const requests=[];const {c}=desktop(config,{fetch:async(url,opts)=>{requests.push({url,body:JSON.parse(opts.body)});return {ok:true,arrayBuffer:async()=>new Uint8Array([1,2]).buffer};}},['jarvisVoiceSettings','elevenLabsSynth','synthesizeUlaw']);
  assert.equal((await c.elevenLabsSynth('Hello',config,{previousText:'Before'})).success,true);
  assert.equal((await c.synthesizeUlaw('Hello')).success,true);
  for(const r of requests){assert.ok(r.url.includes('/'+(config.ttsVoice||JARVIS)+'?'));assert.equal(r.body.model_id,'eleven_flash_v2_5');}
  assert.ok(requests[0].url.includes('mp3_44100_128'));assert.ok(requests[1].url.includes('ulaw_8000'));assert.equal(requests[0].body.previous_text,'Before');
 }
});
test('quota/auth cooldown avoids repeated REST calls',async()=>{
 let count=0;const config={elevenLabsKey:'fake'};
 const {c}=desktop(config,{fetch:async()=>{count++;return {ok:false,status:401,text:async()=>'quota_exceeded'};}},['jarvisVoiceSettings','elevenLabsSynth']);
 assert.ok((await c.elevenLabsSynth('Hi',config)).error);assert.equal((await c.elevenLabsSynth('Again',config)).cooldown,true);assert.equal(count,1);
});
test('ack cache partitions by voice/model/settings and is stable for unrelated configuration',()=>{
 const {c}=desktop({}, {path,crypto,ACKS_DIR:'/cache',ackSlug:t=>t},['jarvisVoiceSettings','ackFilePath']);
 const base=c.ackFilePath('Hi',{});assert.equal(base,c.ackFilePath('Hi',{unrelated:true}));
 for(const config of [{ttsVoice:'ABCDEFGHIJKLMNOPQRST'},{ttsModel:'eleven_turbo_v2_5'},{ttsSpeed:1.2}])assert.notEqual(base,c.ackFilePath('Hi',config));
 assert.notEqual(base,'/cache/Hi.mp3');
});
test('sayLocal respects mute and propagates voice failure without macOS say',async()=>{
 for(const result of [{success:false,skipped:'tts disabled'},{success:false,error:'quota'}]){
  const {c}=desktop({}, {speakDesktop:async()=>result,reportTtsFailure:e=>({success:false,error:e})},['sayLocal']);
  assert.equal(await c.sayLocal('Hello'),result);
 }
});
test('stream synthesis failure clears queue, reports failure, and re-arms microphone',async()=>{
 const idle=[],errors=[];const {c}=desktop({}, {ttsStreamSeq:7,ttsStreamQ:['Hi','Tail'],ttsStreamDraining:false,
  synthesizeSpeech:async()=>({error:'quota'}),latMark(){},reportTtsFailure:e=>errors.push(e),emitTtsIdle:s=>idle.push(s)},['ttsStreamDrain']);
 await c.ttsStreamDrain(7);assert.deepEqual(idle,[7]);assert.deepEqual(errors,['quota']);assert.equal(c.ttsStreamQ.length,0);assert.equal(c.ttsStreamDraining,false);
});
function cloud(env={},fetchImpl){
 const c={module:{exports:{}},process:{env:{ELEVENLABS_API_KEY:'fake',...env}},Buffer,fetch:fetchImpl,console};
 vm.createContext(c);vm.runInContext(read('cloud/src/voice.js'),c);return c.module.exports;
}
test('cloud ignores even valid client voice overrides and uses server JARVIS/flash',async()=>{
 const calls=[];const voice=cloud({},async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,arrayBuffer:async()=>new Uint8Array([1]).buffer};});
 for(const id of ['bm_george','ABCDEFGHIJKLMNOPQRST',undefined])assert.equal((await voice.tts('Hello',{voice:id})).via,'elevenlabs');
 for(const r of calls){assert.ok(r.url.includes('/'+JARVIS+'?'));assert.equal(r.body.model_id,'eleven_flash_v2_5');}
});
test('cloud returns errors for missing key, quota, malformed server voice and network rejection',async()=>{
 assert.ok((await cloud({ELEVENLABS_API_KEY:''},()=>assert.fail('fetch without key')).tts('Hi')).error);
 assert.ok((await cloud({ELEVENLABS_VOICE_ID:'bm_george'},()=>assert.fail('fetch invalid voice')).tts('Hi')).error);
 assert.ok((await cloud({},async()=>({ok:false,status:429,text:async()=>'quota'})).tts('Hi')).error);
 assert.ok((await cloud({},async()=>{throw Error('offline');}).tts('Hi')).error);
});
test('cloud phone failure ends call with top-level Hangup, never Google or nested Hangup in Gather',async()=>{
 const source=read('cloud/src/twilio.js');const a=source.indexOf('const gather ='),b=source.indexOf('\n\n',a);const events=[];
 const c={voice:{tts:async()=>({error:'quota'})},console:{warn(){}},db:{pushActivity:(...v)=>events.push(v)},String,Buffer};vm.createContext(c);
 vm.runInContext(extract(source,'sayEl')+'\n'+source.slice(a,b)+'\nglobalThis.gatherTest=gather;',c);
 const failed=await c.sayEl('host','Hi');assert.equal(failed,'<Hangup/>');const xml=c.gatherTest('host','token',failed,'owner');
 assert.match(xml,/<Response><Hangup\/><\/Response>/);assert.doesNotMatch(xml,/<Gather|<Say/);assert.equal(events.length,1);
});
test('Mac phone synthesis failure throws into route Hangup handling',async()=>{
 const c={synthesize:async()=>({error:'quota'}),String};vm.createContext(c);vm.runInContext(extract(read('mcp-server.js').replace(/^  /gm, ''),'sayElement'),c);
 await assert.rejects(c.sayElement({get:()=> 'host'},'Hi'),/ElevenLabs voice unavailable/);
 assert.doesNotMatch(read('mcp-server.js'),/<Say/);
});
test('stream keeps auto_mode and same selected voice; no alternate voice outputs remain',()=>{
 const ws=read('lib/ttsws.js');assert.ok(ws.includes("c.ttsVoice || c.elevenLabsVoiceId || '"+JARVIS+"'"));assert.ok(ws.includes('auto_mode=true'));
 // One guarded exception: reaching Siddhant on an urgent ladder when no two-way leg passed preflight.
 const guarded=main.match(/if \(allowPlainVoice && digitsOf\(target\)[\s\S]*?\n    \}\n/);assert.ok(guarded,'the substitute-voice branch is guarded');
 assert.doesNotMatch(main.replace(guarded[0],''),/spawn\('say'|<Say/);assert.ok(extract(main,'ttsWsEnsure').includes('ttsRestFeed(seq, text)'));
 for(const f of ['src/mobile.html','phone-app/Web/mobile.html','cloud/public/mobile.html']){const ui=read(f);assert.ok(ui.includes('JARVIS (server-selected ElevenLabs voice)'));assert.ok(!ui.includes('voice: voicePref'));}
});

test('outbound calls resolve the cloud host within the call scope and refuse failed preflight', async () => {
  const placed=[];
  const c={cloudUrl:'https://example.invalid',cloudToken:'test-token',myPhone:'+15555550100',twilioSid:'test',twilioToken:'test',twilioFrom:'+15555550101'};
  let valid=true;
  const context={loadConfig:()=>c,require:()=>()=>({calls:{create:async args=>{placed.push(args);return {sid:'test-call'}}}}),
    getPublicHost:()=>'',publicHostReachable:()=>assert.fail('cloud call must not inspect Tailscale'),
    voicepreflight:{check:async()=>({ok:valid,stage:'test',detail:'failed'})},recordCall:()=>{},console:{warn(){}},Date,String,encodeURIComponent};
  vm.createContext(context);vm.runInContext(extract(main,'twilioCall'),context);
  const success=await context.twilioCall('Voice check',{bypassGate:true});
  assert.equal(success.sent,true);assert.equal(placed.length,1);assert.match(placed[0].url,/example.invalid/);
  valid=false;
  const failure=await context.twilioCall('Voice check',{bypassGate:true});
  assert.equal(failure.sent,false);assert.equal(placed.length,1);
});
