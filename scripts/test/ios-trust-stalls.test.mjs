import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrustStallObserver } from '../../apps/ios/ModexCompanion/Scripts/observe-trust-stalls.mjs';

const device='2CC7A2C1-E1A7-4633-911A-DB60BDEB97F0';
const boot='3E538CD4-EAD9-4CFC-939A-C7DA3EDBD338';
const id='CE535A64-185F-4FD3-8C18-86EE73EB4C42';
const app=`/Users/runner/Library/Developer/CoreSimulator/Devices/${device}/data/Containers/Bundle/Application/C10862C8-D7CA-41C7-B043-7264908A02BB/ModexCompanion.app/ModexCompanion`;
const daemon='/Library/Developer/CoreSimulator/Volumes/iOS_23E254a/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/trustd';
const epoch=Date.parse('2026-11-11T16:22:53.486Z');
const event=(phase,extra={})=>({processID:19815,processImagePath:app,bootUUID:boot,threadID:101,timestamp:new Date(epoch).toISOString(),eventMessage:`MODEX_PAIRING_TLS observer=${id} phase=${phase}`,...extra});
function setup(options={}) {
 let time=epoch;
 const collected=[];
 const identities=new Map([[19815,{image:app,startedAt:epoch-1000,identity:'app-instance'}],[2309,{image:daemon,startedAt:epoch-100000,identity:'daemon-instance'}]]);
 const observer=new TrustStallObserver({deviceId:device,now:()=>time,appImage:async()=>app,identity:async pid=>identities.get(pid),sample:async(pid,{signal})=>{assert.equal(signal.aborted,false);collected.push(pid);return {bytes:100,file:`${pid}.txt`}},...options});
 return {observer,collected,identities,advance:ms=>{time+=ms}};
}
async function blocked(h) {
 await h.observer.ingest(event('chain-start'));
 await h.observer.ingest({processID:19815,processImagePath:app,bootUUID:boot,threadID:101,timestamp:new Date(epoch).toISOString(),eventMessage:'SecTrustEvaluateIfNecessary',activityIdentifier:232431});
 await h.observer.ingest({processID:2309,processImagePath:daemon,bootUUID:boot,timestamp:new Date(epoch).toISOString(),eventMessage:'activating connection: name=com.apple.trustd.peer[19815].abc',activityIdentifier:232431});
}

test('a completed trust callback never triggers stack collection',async()=>{
 const h=setup();await blocked(h);h.advance(100);await h.observer.ingest(event('chain-return'));h.advance(6000);await h.observer.tick();assert.deepEqual(h.collected,[]);assert.equal(h.observer.report.samples.length,0);
});
test('a stalled callback collects only its identity-bound app and correlated same-boot trustd once',async()=>{
 const h=setup();await blocked(h);h.advance(4999);await h.observer.tick();assert.deepEqual(h.collected,[]);h.advance(1);await h.observer.tick();await h.observer.tick();assert.deepEqual(h.collected,[19815,2309]);assert.deepEqual(h.observer.report.samples.map(x=>[x.role,x.state]),[['app','sampled'],['trustd','sampled']]);
});
test('a different simulator image or malformed diagnostic line cannot trigger sampling',async()=>{
 const h=setup();await h.observer.ingest(event('chain-start',{processImagePath:app.replace(device,'foreign-device')}));await h.observer.ingest(event('chain-start',{eventMessage:'MODEX_PAIRING_TLS observer=not-an-id phase=chain-start'}));h.advance(6000);await h.observer.tick();assert.deepEqual(h.collected,[]);
});
test('trustd needs both the original activity and boot identity',async()=>{
 const h=setup();await h.observer.ingest(event('chain-start'));await h.observer.ingest({processID:19815,processImagePath:app,bootUUID:boot,threadID:101,timestamp:new Date(epoch).toISOString(),eventMessage:'SecTrustEvaluateIfNecessary',activityIdentifier:2});await h.observer.ingest({processID:2309,processImagePath:daemon,bootUUID:'foreign-boot',timestamp:new Date(epoch).toISOString(),eventMessage:'name=com.apple.trustd.peer[19815].x',activityIdentifier:2});h.advance(6000);await h.observer.tick();assert.deepEqual(h.collected,[19815]);
});
test('a changed process lifetime or image is refused before collection',async()=>{
 for(const replacement of [{image:app,startedAt:epoch+1,identity:'reused'},{image:'/other',startedAt:epoch-1000,identity:'app-instance'}]){
  const h=setup();await blocked(h);h.identities.set(19815,replacement);h.advance(6000);await h.observer.tick();assert.deepEqual(h.collected,[]);assert.equal(h.observer.report.samples[0].state,'identity-refused');
 }
});
test('a missing app identity is unavailable evidence, not authority to sample a PID',async()=>{
 const h=setup();h.identities.delete(19815);await blocked(h);h.advance(6000);await h.observer.tick();assert.deepEqual(h.collected,[]);
});
test('sampling failure is retained without failing a test or inventing a stack',async()=>{
 const h=setup({sample:async()=>{throw Object.assign(Error('not permitted'),{code:'EPERM'})}});await blocked(h);h.advance(6000);await h.observer.tick();assert.deepEqual(h.observer.report.samples.map(x=>x.state),['unavailable','unavailable']);assert.equal(h.observer.report.samples[0].code,'EPERM');
});
test('a callback returning during identity revalidation suppresses collection',async()=>{
 const h=setup();await blocked(h);const original=h.observer.identity;h.observer.identity=async pid=>{await h.observer.ingest(event('chain-return'));return original(pid)};h.advance(6000);await h.observer.tick();assert.deepEqual(h.collected,[]);
});
test('stopping the observer aborts only its sample operation and suppresses future collection',{timeout:2000},async()=>{
 let entered,signal;const started=new Promise(r=>entered=r);
 const h=setup({sample:async(_pid,opts)=>{signal=opts.signal;entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));throw Object.assign(Error('aborted'),{code:'ABORT_ERR'})}});await blocked(h);h.advance(6000);const running=h.observer.tick();await started;h.observer.close();await running;assert.equal(signal.aborted,true);assert.equal(h.observer.report.samples.length,1);await h.observer.tick();assert.equal(h.observer.report.samples.length,1);
});
test('unique observer and capture floods remain bounded',async()=>{
 const h=setup();for(let n=0;n<140;n++)await h.observer.ingest(event('chain-start',{eventMessage:`MODEX_PAIRING_TLS observer=00000000-0000-4000-8000-${String(n).padStart(12,'0')} phase=chain-start`}));h.advance(6000);await h.observer.tick();assert.ok(h.observer.report.samples.length<=4);assert.ok(h.observer.report.refusals.length<=16);assert.ok(h.observer.report.observers<=128);
});

test('bounded commands preserve bytes and reject overflow without retaining partial output',async()=>{
 const { runBounded }=await import('../../apps/ios/ModexCompanion/Scripts/observe-trust-stalls.mjs');
 const ok=await runBounded(process.execPath,['-e','process.stdout.write("owned-output")'],{maxBytes:100,timeoutMs:2000});assert.equal(ok.stdout.toString(),'owned-output');
 await assert.rejects(runBounded(process.execPath,['-e','process.stdout.write("x".repeat(200000))'],{maxBytes:100,timeoutMs:2000}),e=>e.code==='OUTPUT_LIMIT'&&e.closed===true);
});
test('bounded command timeout and cancellation settle after their own child closes',{timeout:5000},async()=>{
 const { runBounded }=await import('../../apps/ios/ModexCompanion/Scripts/observe-trust-stalls.mjs');
 await assert.rejects(runBounded(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{timeoutMs:500}),e=>e.code==='COMMAND_TIMEOUT'&&e.closed===true);
 const abort=new AbortController();abort.abort();await assert.rejects(runBounded(process.execPath,['-e','process.exit(99)'],{signal:abort.signal}),e=>e.code==='ABORT_ERR');
});

test('an older activity cannot bind a new callback to a previous daemon exchange',async()=>{
 const h=setup();await h.observer.ingest(event('chain-start',{timestamp:new Date(epoch+1).toISOString()}));
 await h.observer.ingest({processID:19815,processImagePath:app,bootUUID:boot,threadID:101,timestamp:new Date(epoch).toISOString(),eventMessage:'SecTrustEvaluateIfNecessary',activityIdentifier:232431});
 await h.observer.ingest({processID:2309,processImagePath:daemon,bootUUID:boot,timestamp:new Date(epoch).toISOString(),eventMessage:'com.apple.trustd.peer[19815]',activityIdentifier:232431});h.advance(6000);await h.observer.tick();assert.deepEqual(h.collected,[19815]);
});
test('stack capture refuses an unknown process birth before launching a command',async t=>{
 const { captureStack }=await import('../../apps/ios/ModexCompanion/Scripts/observe-trust-stalls.mjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'modex-stack-invalid-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 await assert.rejects(captureStack(process.pid,{directory,role:'app',observer:id}),e=>e.code==='INVALID_TARGET');
});

test('another thread cannot assign its Security activity to the stalled callback',async()=>{
 const h=setup();await h.observer.ingest(event('chain-start',{threadID:101}));
 await h.observer.ingest({processID:19815,processImagePath:app,bootUUID:boot,threadID:999,timestamp:new Date(epoch).toISOString(),eventMessage:'SecTrustEvaluateIfNecessary',activityIdentifier:232431});
 await h.observer.ingest({processID:2309,processImagePath:daemon,bootUUID:boot,threadID:2,timestamp:new Date(epoch).toISOString(),eventMessage:'com.apple.trustd.peer[19815]',activityIdentifier:232431});h.advance(6000);await h.observer.tick();assert.deepEqual(h.collected,[19815]);
});

for (const [name,ci,configuration,expectObserver] of [['CI Debug',true,'Debug',true],['local Debug',false,'Debug',false],['CI Release',true,'Release',false]]) {
 test(`paired shell harness preserves Xcode failure and owns helpers for ${name}`,{timeout:10000,skip:process.platform==='win32'&&'POSIX paired harness'},async t=>{
 const {spawnSync}=await import('node:child_process');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'modex-trust-harness-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const scriptDir=path.join(directory,'apps/ios/ModexCompanion/Scripts'),bin=path.join(directory,'bin'),trace=path.join(directory,'trace.jsonl'),ready=path.join(directory,'observer-ready');
 fs.mkdirSync(scriptDir,{recursive:true});fs.mkdirSync(path.join(scriptDir,'../UITests'));fs.mkdirSync(bin);
 fs.copyFileSync(new URL('../../apps/ios/ModexCompanion/Scripts/test-e2e.sh',import.meta.url),path.join(scriptDir,'test-e2e.sh'));
 for(const name of ['pnpm','xcodegen'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
 fs.writeFileSync(path.join(bin,'node'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');const [file,...args]=process.argv.slice(2);const role=path.basename(file)==='fixture.mjs'?'fixture':'observer';const log=event=>fs.appendFileSync(process.env.MODEX_TEST_TRUST_TRACE,JSON.stringify({role,event,pid:process.pid,args})+'\\n');log('start');if(role==='fixture')fs.writeFileSync(args[0],'{"link":"synthetic"}');else fs.writeFileSync(process.env.MODEX_TEST_TRUST_READY,'ready');setInterval(()=>{},1000);process.on('SIGTERM',()=>{log('stop');process.exit(0)});
`,{mode:0o755});
 fs.writeFileSync(path.join(bin,'xcodebuild'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);if(args.includes('build-for-testing')){const data=args[args.indexOf('-derivedDataPath')+1];fs.mkdirSync(path.join(data,'Build/Products'),{recursive:true});fs.writeFileSync(path.join(data,'Build/Products/ModexCompanion_fixture.xctestrun'),'fixture');process.exit(0)}if(process.env.MODEX_TEST_TRUST_EXPECT!=='1')process.exit(17);const until=Date.now()+1500;const wait=()=>{if(fs.existsSync(process.env.MODEX_TEST_TRUST_READY)||Date.now()>until)process.exit(17);else setTimeout(wait,10)};wait();
`,{mode:0o755});
 const result=spawnSync('bash',[path.join(scriptDir,'test-e2e.sh')],{encoding:'utf8',timeout:8000,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,GITHUB_ACTIONS:ci?'true':'false',RUNNER_OS:'macOS',MODEX_IOS_CONFIGURATION:configuration,MODEX_IOS_UDID:device,MODEX_IOS_DERIVED_DATA:path.join(directory,'derived'),MODEX_TEST_TRUST_TRACE:trace,MODEX_TEST_TRUST_READY:ready,MODEX_TEST_TRUST_EXPECT:expectObserver?'1':'0'}});
 assert.ifError(result.error);assert.equal(result.status,17,result.stderr);const events=fs.readFileSync(trace,'utf8').trim().split('\n').map(x=>JSON.parse(x));
 const roles=expectObserver?['fixture','observer']:['fixture'];assert.deepEqual(events.filter(x=>x.event==='start').map(x=>x.role).sort(),roles);
 assert.deepEqual(events.filter(x=>x.event==='stop').map(x=>x.role).sort(),roles);
 const observer=events.find(x=>x.role==='observer');if(expectObserver){assert.deepEqual(observer.args.slice(0,2),['--device',device]);assert.equal(events.filter(x=>x.role==='observer'&&x.event==='start').length,1)}else assert.equal(observer,undefined);
 });
}

test('one unconfirmed child close permanently stops all subsequent diagnostic commands',async()=>{
 const {gateCommands}=await import('../../apps/ios/ModexCompanion/Scripts/observe-trust-stalls.mjs');let calls=0;const unknown=[];
 const run=gateCommands(async()=>{calls++;throw Object.assign(Error('not closed'),{code:'COMMAND_TIMEOUT',pid:12345,closed:false})},x=>unknown.push(x));
 await assert.rejects(run('/tool',[]),e=>e.code==='COMMAND_TIMEOUT');
 await assert.rejects(run('/another-tool',[]),e=>e.code==='DIAGNOSTIC_STOPPED');
 assert.equal(calls,1);assert.deepEqual(unknown,[{pid:12345,code:'COMMAND_TIMEOUT'}]);
});
