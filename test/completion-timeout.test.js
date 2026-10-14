import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgy } from '../src/lib/process.js';
import { normalizeConfig } from '../src/lib/config.js';
import { fixture, fakeContext, helpers, testDeps, makeMockToken } from './fixtures.js';
import { executeWithHelpers } from '../src/server/execute.js';

const run = (timeoutMs) => runAgy({command:process.execPath,args:['-e',`setTimeout(()=>{console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'verified'}}));},100);`],cwd:process.cwd(),env:process.env,prompt:'verify',timeoutMs,graceMs:100,maxBytes:8192,outputInactivityTimeoutMs:null});

test('zero wall-clock timeout waits for the actual terminal result',async()=>{
 const result=await run(0);
 assert.equal(result.code,0);
 assert.equal(result.timedOut,false);
 assert.equal(result.final.status,'SUCCESS');
});
test('an explicitly configured wall-clock timeout still stops the process',async()=>{
 const result=await run(20);
 assert.equal(result.timedOut,true);
});
test('configuration defaults to no wall-clock limit and preserves explicit limits',async t=>{
 const f=await fixture(t);
 const config={...f.config};delete config.timeoutSec;delete config.timeoutPolicy;
 assert.equal(normalizeConfig(config).timeoutSec,0);
 assert.equal(normalizeConfig({...config,timeoutPolicy:'bounded',timeoutSec:900}).timeoutSec,900);
 assert.equal(normalizeConfig({...config,timeoutSec:900}).timeoutSec,0,'legacy timeout values do not override completion policy');
 assert.throws(()=>normalizeConfig({...config,timeoutPolicy:'bounded',timeoutSec:0}));
 assert.throws(()=>normalizeConfig({...config,timeoutSec:-1}));
});
test('an interrupted turn retains its workspace-bound conversation and verified usage',async t=>{
 const f=await fixture(t);f.config.promptPolicy='full_every_turn';
 process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD=makeMockToken('account@example.com');
 const {ctx}=fakeContext(f.config);
 const first=await executeWithHelpers(ctx,helpers,testDeps);
 ctx.runtime.sessionParams=first.sessionParams;
 ctx.context.taskTitle='SCENARIO_HANG';ctx.config={...f.config,timeoutSec:1};
 const stopped=await executeWithHelpers(ctx,helpers,testDeps);
 assert.equal(stopped.timedOut,true);
 assert.deepEqual(stopped.resultJson.adapterExecutionTimeout,{timeoutSec:1,source:'configured'});
 assert.equal(stopped.clearSession,false);
 assert.equal(stopped.sessionParams.conversationId,first.sessionParams.conversationId);
 assert.deepEqual(stopped.sessionParams.usageTotals,first.sessionParams.usageTotals);
});

test('CLI cannot auto-finalize at a competing deadline and completion policy preserves an existing conversation',async t=>{
 const f=await fixture(t);f.config.timeoutPolicy='completion';f.config.timeoutSec=900;
 const {ctx}=fakeContext(f.config);const metas=[];ctx.onMeta=async meta=>metas.push(meta);
 const first=await executeWithHelpers(ctx,helpers,testDeps);
 assert.equal(first.exitCode,0,JSON.stringify(first));
 assert.deepEqual(first.resultJson.adapterExecutionTimeout,{timeoutSec:0,source:'unlimited'});
 ctx.runtime.sessionParams=first.sessionParams;
 const second=await executeWithHelpers(ctx,helpers,testDeps);
 assert.equal(second.exitCode,0,JSON.stringify(second));
 const args=metas[1].commandArgs;
 assert.equal(args[args.indexOf('--print-timeout')+1],'0');
 assert.equal(args[args.indexOf('--conversation')+1],first.sessionParams.conversationId);
});
