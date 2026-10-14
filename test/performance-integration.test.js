import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fixture, fakeContext, helpers, testDeps, makeMockToken } from './fixtures.js';
import { executeWithHelpers } from '../src/server/execute.js';
import { createServerAdapter } from '../src/server/index.js';
import { observeExecutionAccount } from '../src/lib/account.js';
import { syncKeychainToPool } from '../src/lib/account-pool.js';

async function isolatedAccount(t,f) {
  const previous=process.env.PAPERCLIP_AGY_STATUS_FILE;
  process.env.PAPERCLIP_AGY_STATUS_FILE=path.join(f.root,'missing-status.json');
  process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD=makeMockToken('first@example.com');
  t.after(()=>{if(previous===undefined)delete process.env.PAPERCLIP_AGY_STATUS_FILE;else process.env.PAPERCLIP_AGY_STATUS_FILE=previous;});
}
test('repeated execution reuses validation; explicit refresh and credential changes force live discovery',async t=>{
  const f=await fixture(t);await isolatedAccount(t,f);
  const count=path.join(f.root,'discoveries');
  const original=await readFile(f.exe,'utf8');
  await writeFile(f.exe,original.replace("if(process.argv.includes('models')){console.log",`if(process.argv.includes('models')){require('fs').appendFileSync(${JSON.stringify(count)},'lookup\\n');console.log`));
  const adapter=createServerAdapter(),{ctx}=fakeContext(f.config);
  const deps={estimateCost:testDeps.estimateCost};
  const run=async()=>{const result=await executeWithHelpers(ctx,helpers,deps);assert.equal(result.exitCode,0,JSON.stringify(result));ctx.runtime.sessionParams=result.sessionParams;return result;};
  await run();await run();
  assert.equal((await readFile(count,'utf8')).trim().split('\n').length,1);
  // UI refresh invalidates the same cache used by the public server executor.
  await adapter.refreshModels({config:f.config});await run();
  assert.equal((await readFile(count,'utf8')).trim().split('\n').length,3);
  process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD=makeMockToken('second@example.com');
  await run();
  assert.equal((await readFile(count,'utf8')).trim().split('\n').length,4);
  await writeFile(f.exe,original+'\n// changed binary\n');
  await run(); // An executable update also invalidates authorization.
  const traces=(await readFile(path.join(f.config.traceDirectory,(await import('../src/lib/journal.js')).journalPath(ctx.runId).split(path.sep).at(-1)),'utf8')).trim().split('\n').map(JSON.parse);
  const performance=traces.filter(e=>e.kind==='process.exit').map(e=>e.data.performance);
  assert.deepEqual(performance.map(p=>p.modelValidationCacheHit),[false,true,false,false,false]);
  assert.ok(traces.some(e=>e.kind==='run.performance.final'));
  assert.ok(!JSON.stringify(traces).includes('credentialVersion'));
});
test('account pool reuses a fresh observation without rewriting unchanged durable state',async t=>{
  const f=await fixture(t);await isolatedAccount(t,f);
  const {active}=await observeExecutionAccount();
  const first=await syncKeychainToPool(null,f.mockPoolFile,active);
  const before=await stat(f.mockPoolFile);
  // If sync incorrectly probes again it would store this changed identity.
  process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD=makeMockToken('second@example.com');
  const second=await syncKeychainToPool(null,f.mockPoolFile,active);
  const after=await stat(f.mockPoolFile);
  assert.equal(first.activeAccount,'first@example.com');assert.equal(second.activeAccount,'first@example.com');
  assert.equal(before.ino,after.ino);assert.equal(before.mtimeMs,after.mtimeMs);
});
test('stream bursts preserve text, lifecycle order and the full raw audit while reducing callbacks',async t=>{
  const f=await fixture(t);await isolatedAccount(t,f);
  await writeFile(f.exe,`#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const events=[{event:'init',conversation_id:'burst-session',init:{permission_mode:'request-review'}}];
for(let i=0;i<1000;i++)events.push({event:'step_update',step_update:{step_type:'agent_response',text_delta:'delta '}});
events.push({event:'step_update',step_update:{step_type:'tool',step_index:1,tool_name:'view_file',state:'ACTIVE',tool_info:{parameters:{path:'source.js'}}}});
events.push({event:'step_update',step_update:{step_type:'tool',step_index:1,tool_name:'view_file',state:'DONE',tool_info:{output:'contents'}}});
events.push({event:'result',result:{status:'SUCCESS',conversation_id:'burst-session',response:'done',usage:{input_tokens:10,output_tokens:5,cached_input_tokens:0}}});
process.stdout.write(events.map(JSON.stringify).join('\\n')+'\\n');});`);
  const {ctx,logs}=fakeContext({...f.config,maxOutputBytes:1_000_000});
  const progress=[];ctx.onRuntimeProgress=async value=>progress.push(value);
  const result=await executeWithHelpers(ctx,helpers,testDeps);
  assert.equal(result.exitCode,0,JSON.stringify(result));
  const messages=logs.filter(([stream])=>stream==='stdout').flatMap(([,text])=>text.trim().split('\n').map(JSON.parse));
  const text=messages.filter(m=>m.type==='acpx.text_delta');
  assert.equal(text.map(m=>m.text).join(''),'delta '.repeat(1000));
  assert.ok(text.length<20,`delivered ${text.length} text batches`);
  assert.ok(progress.length<20,`delivered ${progress.length} progress updates`);
  assert.ok(messages.findIndex(m=>m.type==='acpx.tool_call')>messages.findLastIndex(m=>m.type==='acpx.text_delta'));
  assert.equal(progress.at(-1).phase,'finalize');
  const {journalPath}=await import('../src/lib/journal.js');
  const trace=(await readFile(journalPath(ctx.runId,f.config.traceDirectory),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(trace.filter(e=>e.kind==='cli.event'&&e.data.step_update?.step_type==='agent_response').length,1000);
  const performance=trace.find(e=>e.kind==='run.performance.final').data;
  assert.equal(performance.streamDelivery.textDeltas,1000);
  assert.ok(performance.journal.writes<performance.journal.records/2);
  assert.ok(performance.callbackMetrics.onLog.calls>0);
});
test('telemetry persistence failures cannot produce a successful turn',async t=>{
 const f=await fixture(t);await isolatedAccount(t,f);
 const {ctx}=fakeContext(f.config);
 ctx.onLog=async (stream,text)=>{if(text.includes('acpx.text_delta'))throw Error('transcript storage unavailable');};
 const result=await executeWithHelpers(ctx,helpers,testDeps);
 assert.equal(result.exitCode,1);
 assert.match(result.errorMessage,/transcript storage unavailable/);
});
test('repeated unchanged investigation is recognised across resumed turns and survives session serialization',async t=>{
  const f=await fixture(t);await isolatedAccount(t,f);
  const {ctx}=fakeContext(f.config,'SCENARIO_TOOL_ERROR');
  ctx.context.wakeCommentBody='SCENARIO_TOOL_ERROR';
  const adapter=createServerAdapter();
  const run=async()=>{const result=await executeWithHelpers(ctx,helpers,testDeps);assert.equal(result.exitCode,0,JSON.stringify(result));ctx.runtime.sessionParams=adapter.sessionCodec.deserialize(adapter.sessionCodec.serialize(result.sessionParams));return result;};
  await run();const second=await run();const third=await run();
  assert.ok(second.resultJson.efficiency.exactRepeatCalls>0);
  assert.ok(third.resultJson.efficiency.unchangedRepeatResults>0);
  ctx.context.forceFreshSession=true;
  const fresh=await run();assert.equal(fresh.resultJson.efficiency.exactRepeatCalls,0);
});
