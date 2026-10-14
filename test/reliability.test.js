import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {sanitizeStatuslinePayload,writeObservedStatus,readObservedStatus} from '../src/lib/statusline.js';
import {loadAccountPool,saveAccountPool,updateAccountPool,activateAccount,isAccountReadyForModel} from '../src/lib/account-pool.js';
import {getQuotaWindows} from '../src/lib/quota.js';
import {usageSince} from '../src/lib/usage.js';
import {createServerAdapter} from '../src/server/index.js';
import {normalizeConfig} from '../src/lib/config.js';
import {executeWithHelpers,sanitizeTelemetry} from '../src/server/execute.js';
import {fixture,fakeContext,helpers,makeMockToken,testDeps} from './fixtures.js';

async function temp(t){const dir=await mkdtemp(path.join(tmpdir(),'agy-resilience-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('status snapshot is whitelisted, mode 0600, and atomically follows terminal account changes',async t=>{
 const dir=await temp(t),file=path.join(dir,'status.json');
 await writeObservedStatus({email:'FIRST@Example.com',model:{id:'gemini-3.8-flash-low'},
  quota:{'gemini-3.8-flash-low':{remaining_fraction:0.5,reset_in_seconds:120}},
  tokenPayload:'secret',password:'secret'},file);
 assert.equal((await stat(file)).mode & 0o777,0o600);
 assert.doesNotMatch(await readFile(file,'utf8'),/secret|tokenPayload|password/);
 const first=await readObservedStatus({filePath:file});
 assert.equal(first.email,'first@example.com');
 assert.equal(first.quota['gemini-3.8-flash-low'].remainingFraction,0.5);
 await writeObservedStatus({email:'second@example.com',model:{id:'claude-sonnet-4-6'}},file);
 assert.equal((await readObservedStatus({filePath:file})).email,'second@example.com');
 assert.equal((await readObservedStatus({filePath:file,maxAgeMs:10,now:Date.now()+1000})),null);
});

test('invalid account registry raises rather than silently resetting accounts',async t=>{
 const dir=await temp(t),file=path.join(dir,'pool.json');
 await writeFile(file,'{damaged');
 await assert.rejects(loadAccountPool(file),/refused to discard state/);
 assert.equal(await readFile(file,'utf8'),'{damaged');
});

test('legacy credentials are removed from new registry snapshots',async t=>{
 const dir=await temp(t),file=path.join(dir,'pool.json');
 await writeFile(file,JSON.stringify({version:1,activeAccount:'user@example.com',accounts:[{
  email:'user@example.com',status:'ready',tokenPayload:'fake-oauth-secret',refreshToken:'secret'}]}));
 const pool=await loadAccountPool(file);
 assert.equal(pool.accounts[0].tokenPayload,undefined);
 await saveAccountPool(pool,file);
 assert.doesNotMatch(await readFile(file,'utf8'),/fake-oauth|refreshToken/);
 assert.equal((await stat(file)).mode & 0o777,0o600);
 assert.equal(await activateAccount(),false);
});

test('concurrent registry mutations serialize without lost updates',async t=>{
 const dir=await temp(t),file=path.join(dir,'pool.json');
 const initial=await loadAccountPool(file);
 await saveAccountPool(initial,file);
 await Promise.all(Array.from({length:12},(_,i)=>updateAccountPool(pool=>{
   pool.accounts.push({email:`account${i}@example.test`,status:'observed'});
 },file,{waitMs:10000})));
 assert.equal((await loadAccountPool(file)).accounts.length,12);
});

test('usage deltas subtract cumulative history and never fabricate an absent baseline',()=>{
 const first=usageSince({input_tokens:1000,output_tokens:100,cache_read_tokens:700,thinking_tokens:40});
 assert.equal(first.usageBasis,'turn_delta');
 assert.deepEqual(first.usage,{inputTokens:1000,outputTokens:100,cachedInputTokens:700,thinkingTokens:40});
 const second=usageSince({input_tokens:1230,output_tokens:180,cache_read_tokens:1050,thinking_tokens:65},first.usageTotals,{isResume:true});
 assert.deepEqual(second.usage,{inputTokens:230,outputTokens:80,cachedInputTokens:350,thinkingTokens:25});
 const unknown=usageSince({input_tokens:1230,output_tokens:180},null,{isResume:true});
 assert.equal(unknown.usage,null);
 assert.equal(unknown.usageBasis,'cumulative_without_baseline');
 assert.equal(usageSince({},null).usageBasis,'unavailable');
 assert.throws(()=>usageSince({input_tokens:1,output_tokens:100},first.usageTotals,{isResume:true}),/decreased/);
});

test('adapter exposes native live model and quota hooks and user model combobox',()=>{
 const adapter=createServerAdapter();
 assert.equal(typeof adapter.listModels,'function');
 assert.equal(typeof adapter.refreshModels,'function');
 assert.equal(typeof adapter.getQuotaWindows,'function');
 const modelField=adapter.getConfigSchema().fields.find(f=>f.key==='model');
 assert.equal(modelField.type,'combobox');
 assert.deepEqual(modelField.options,[]);
 const cfg=normalizeConfig({cwd:'/tmp/project',allowedWorkspaceRoot:'/tmp/project',model:'gemini-3.8-flash-low'});
 assert.equal(cfg.validateSelectedModelOnRun,true);
 assert.equal(cfg.enableAccountRotation,false);
});

test('model removed from live agy model list fails before spawn',async t=>{
 const f=await fixture(t); const {ctx,spawned}=fakeContext({...f.config,validateSelectedModelOnRun:true,model:'claude-sonnet-4-6'});
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(result.exitCode,0);
 assert.match(result.errorMessage,/no longer available/);
 assert.equal(spawned.length,0);
});

test('changing an authenticated account continues the same task conversation',async t=>{
 const f=await fixture(t);
 process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD=makeMockToken('first@example.com');
 const {ctx}=fakeContext(f.config);
 const first=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(first.exitCode,0,JSON.stringify(first));
 assert.equal(first.sessionParams.account,'first@example.com');
 ctx.runtime.sessionParams=first.sessionParams;
 process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD=makeMockToken('second@example.com');
 const events=[],metas=[];
 ctx.onEvent=async e=>events.push(e);ctx.onMeta=async x=>metas.push(x);
 const second=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(second.exitCode,0,JSON.stringify(second));
 assert.equal(second.sessionParams.account,'second@example.com');
 assert.ok(events.some(e=>e.eventType==='account.switched'));
 assert.equal(metas[0].commandArgs.includes('--conversation'),true);
 assert.equal(metas[0].commandArgs[metas[0].commandArgs.indexOf('--conversation')+1],first.sessionParams.conversationId);
});

test('model change on the same task starts a fresh model-specific session',async t=>{
 const f=await fixture(t);const {ctx}=fakeContext(f.config);
 ctx.runtime.sessionParams={conversationId:'abcde-123',cwd:f.secondary,taskKey:'task-123',model:'another-model'};
 const metas=[];ctx.onMeta=async m=>metas.push(m);
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.exitCode,0,JSON.stringify(result));
 assert.equal(metas[0].commandArgs.includes('--conversation'),false);
});

test('quota health renders only fresh observed provider windows',async t=>{
 const dir=await temp(t),file=path.join(dir,'agy-status.json');
 const before=process.env.PAPERCLIP_AGY_STATUS_FILE;
 process.env.PAPERCLIP_AGY_STATUS_FILE=file;
 t.after(()=>{if(before===undefined)delete process.env.PAPERCLIP_AGY_STATUS_FILE;else process.env.PAPERCLIP_AGY_STATUS_FILE=before;});
 assert.equal((await getQuotaWindows()).ok,false);
 await writeObservedStatus({email:'account@example.com',model:{id:'gemini-3.8-flash-low'},quota:{'gemini-3.8-flash-low':{remaining_fraction:0.75,reset_in_seconds:600}}},file);
 const r=await getQuotaWindows();
 assert.equal(r.ok,true);assert.equal(r.windows[0].usedPercent,25);
 assert.match(r.source,/account@example.com/);
});

test('telemetry redacts run token and secret-key-shaped arguments',()=>{
 const data={message:'Authorization token-123',payload:{api_key:'key-123',password:'pw',output:'token-123 elsewhere'}};
 const safe=sanitizeTelemetry(data,'token-123');
 assert.equal(safe.payload.api_key,'[REDACTED]');
 assert.equal(safe.payload.password,'[REDACTED]');
 assert.doesNotMatch(JSON.stringify(safe),/token-123|key-123|"pw"/);
});

test('quota preserves the workspace-bound continuation without replaying it',async t=>{
 const f=await fixture(t);const {ctx,spawned}=fakeContext(f.config);
 process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD=makeMockToken('same@example.com');
 const first=await executeWithHelpers(ctx,helpers,testDeps);
 assert.equal(first.exitCode,0,JSON.stringify(first));
 ctx.runtime.sessionParams=first.sessionParams;ctx.context.taskTitle='SCENARIO_QUOTA';
 const quota=await executeWithHelpers(ctx,helpers,testDeps);
 assert.equal(quota.errorCode,'provider_quota');assert.equal(quota.clearSession,false);
 assert.deepEqual(quota.sessionParams,{...first.sessionParams,resumeRequired:true});
 assert.equal(spawned.length,2,'only the two requested turns run; no automatic retry');
 ctx.runtime.sessionParams={...first.sessionParams,promptSignature:null};
 const legacy=await executeWithHelpers(ctx,helpers,testDeps);
 assert.equal(legacy.clearSession,false,'workspace-bound legacy conversations retain progress');
 assert.equal(legacy.sessionParams.conversationId,first.sessionParams.conversationId);
});
test('execution accepts host adapterConfig fallback and rejects invalid inactivity settings',async t=>{
 const f=await fixture(t);const {ctx}=fakeContext(f.config);delete ctx.config;
 const result=await executeWithHelpers(ctx,helpers,testDeps);assert.equal(result.exitCode,0,JSON.stringify(result));
 for (const bad of [-1,NaN,Infinity,1.5,'invalid']) assert.throws(()=>normalizeConfig({...f.config,outputInactivityTimeoutMs:bad}));
 assert.equal(normalizeConfig({...f.config,outputInactivityTimeoutMs:null}).outputInactivityTimeoutMs,null);
 assert.doesNotThrow(()=>createServerAdapter().getRuntimeCommandSpec());
});
