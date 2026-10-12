import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, realpath, symlink} from 'node:fs/promises';
import path from 'node:path';
import {fixture,fakeContext,helpers,makeMockToken} from './fixtures.js';
import {executeWithHelpers, formatToolProgress} from '../src/server/execute.js';
import {normalizeConfig} from '../src/lib/config.js';
import {sessionCodec} from '../src/lib/result.js';
import {createServerAdapter} from '../src/server/index.js';
import { parseAgyModels, discoverAgyModels, makeModelCommand } from '../src/lib/models.js';
import { testEnvironment } from '../src/server/test.js';
import { estimateCostUsd } from '../src/lib/pricing.js';

test('metadata conforms to required external-adapter shape',()=>{
  const a=createServerAdapter();
  assert.equal(a.type,'antigravity_local');
  assert.equal(typeof a.execute,'function');assert.equal(typeof a.testEnvironment,'function');
  assert.equal(typeof a.getConfigSchema,'function');
});
test('reject unsafe config and unsupported command injection',()=>{
  assert.throws(()=>normalizeConfig({cwd:'/tmp/x',allowedWorkspaceRoot:'/tmp/x',command:'agy; echo bad'}));
  assert.throws(()=>normalizeConfig({cwd:'/tmp/x',allowedWorkspaceRoot:'/tmp/x',sandbox:false}));
  assert.throws(()=>normalizeConfig({cwd:'/tmp/x',allowedWorkspaceRoot:'/tmp/x',executionMode:'implementation'}));
  assert.throws(()=>normalizeConfig({cwd:'/tmp/x',allowedWorkspaceRoot:'/tmp/x',extraArgs:['--dangerously-skip-permissions']}));
});
test('successful response records real session and usage; hides token from logs',async(t)=>{
 const f=await fixture(t);const {ctx,logs,spawned}=fakeContext(f.config);
 const r=await executeWithHelpers(ctx,helpers);
 assert.equal(r.exitCode,0,JSON.stringify(r));
 assert.equal(r.sessionParams.conversationId,'abcde-123');
 assert.equal(r.usage.inputTokens,123);
 assert.equal(r.usageBasis,'session_cumulative');
 assert.equal(r.costStatus,'reported');
 assert.equal(typeof r.costUsd,'number');
 assert.equal(r.billingType,'metered_api');
 assert.equal(r.biller,'google');
 assert.ok(logs.some(x=>x[1].includes('done')));
 assert.ok(logs.some(x=>x[1].includes('"acpx.text_delta"')));
 assert.ok(!JSON.stringify(logs).includes('test-token'));
 assert.equal(spawned.length,1);
});
test('resumes known conversation only within same workspace and task',async(t)=>{
 const f=await fixture(t);const {ctx}=fakeContext(f.config);
 // The macOS temp directory can be written /var/folders but resolve to
 // /private/var/folders. A session created with that alias must still resume.
 const alias=path.join(f.root,'alias-to-pilot');
 await symlink(f.secondary,alias,'dir');
 ctx.runtime.sessionParams={conversationId:'abcde-123',cwd:alias,taskKey:'task-123'};
 const resumed=await executeWithHelpers(ctx,helpers);
 assert.equal(resumed.exitCode,0,JSON.stringify(resumed));
 assert.equal(resumed.sessionParams.cwd,await realpath(f.secondary));
 ctx.runtime.sessionParams={conversationId:'abcde-123',cwd:f.primary,taskKey:'task-123'};
 const r=await executeWithHelpers(ctx,helpers);
 assert.notEqual(r.exitCode,0);
 assert.match(r.errorMessage,/another workspace/);
 ctx.runtime.sessionParams={conversationId:'abcde-123',cwd:alias,taskKey:'another-task'};
 const wrongTask=await executeWithHelpers(ctx,helpers);
 assert.notEqual(wrongTask.exitCode,0);
 assert.match(wrongTask.errorMessage,/another workspace or task/);
});
test('fails closed for CLI ERROR, malformed output, missing final result and permission denial',async(t)=>{
 const f=await fixture(t);
 for(const label of ['SCENARIO_ERROR','SCENARIO_MALFORMED','SCENARIO_NO_RESULT','SCENARIO_SOFT_DENY','SCENARIO_AUTO_APPROVE']){
  const {ctx}=fakeContext(f.config,label); const r=await executeWithHelpers(ctx,helpers);
  assert.notEqual(r.exitCode,0,`${label}: ${JSON.stringify(r)}`);
 }
});
test('quota / token limit failure classifies provider_quota and clears session', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_QUOTA');
 const r=await executeWithHelpers(ctx,helpers);
 assert.notEqual(r.exitCode,0);
 assert.equal(r.errorCode,'provider_quota');
 assert.equal(r.resultJson?.errorFamily,'provider_quota');
 assert.equal(r.clearSession,true);
 assert.match(r.errorMessage,/token limit \/ quota reached/i);
});
test('auth failure classifies provider_auth_error and clears session', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_AUTH_FAIL');
 const r=await executeWithHelpers(ctx,helpers);
 assert.notEqual(r.exitCode,0);
 assert.equal(r.errorCode,'provider_auth_error');
 assert.equal(r.resultJson?.errorFamily,'auth');
 assert.equal(r.clearSession,true);
 assert.match(r.errorMessage,/authentication/i);
});
test('turn limit hit classifies agent_turn_limit_reached and retains session', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_TURN_LIMIT');
 const r=await executeWithHelpers(ctx,helpers);
 assert.equal(r.exitCode,53);
 assert.equal(r.errorCode,'agent_turn_limit_reached');
 assert.equal(r.resultJson?.errorFamily,'execution');
 assert.equal(r.clearSession,false);
 assert.match(r.errorMessage,/turn limit/i);
});
test('unclassified error includes first line of stderr in error message', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_UNCLASSIFIED');
 const r=await executeWithHelpers(ctx,helpers);
 assert.notEqual(r.exitCode,0);
 assert.match(r.errorMessage,/fatal: custom execution error occurred/);
});
test('failure during conversation resume automatically clears session', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_FAIL_RESUME');
 ctx.runtime.sessionParams={conversationId:'abcde-123',cwd:f.secondary,taskKey:'task-123'};
 const r=await executeWithHelpers(ctx,helpers);
 assert.notEqual(r.exitCode,0);
 assert.equal(r.clearSession,true);
});
test('planning detects unexpected file creation',async(t)=>{
 const f=await fixture(t);const {ctx}=fakeContext(f.config,'SCENARIO_WRITE');
 const result=await executeWithHelpers(ctx,helpers);
 assert.notEqual(result.exitCode,0);
 assert.match(result.errorMessage,/modified the worktree/);
});
test('planning fails before CLI spawn on dirty tree',async(t)=>{
 const f=await fixture(t);await writeFile(path.join(f.secondary,'dirty.txt'),'dirty');
 const {ctx,spawned}=fakeContext(f.config);const r=await executeWithHelpers(ctx,helpers);
 assert.notEqual(r.exitCode,0);assert.equal(spawned.length,0);
});
test('cancels child process and returns failure',async(t)=>{
 const f=await fixture(t);const {ctx}=fakeContext(f.config,'SCENARIO_HANG');
 const ac=new AbortController();ctx.signal=ac.signal;
 setTimeout(()=>ac.abort(),350);
 const r=await executeWithHelpers(ctx,helpers);
 assert.notEqual(r.exitCode,0);
 assert.match(r.errorMessage,/canceled/i);
});
test('codec discards invalid sessions and preserves taskKey',()=>{
 assert.equal(sessionCodec.deserialize({conversationId:'!!'}),null);
 const original={conversationId:'abcde-123',cwd:'/a',taskKey:'t'};
 assert.equal(sessionCodec.deserialize(sessionCodec.serialize(original)).taskKey,'t');
});

test('extracts account model slugs from documented agy output',()=>{
 const input = 'Available models:\n  gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n  claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)\n  gpt-oss-120b             GPT OSS 120B\n';
 assert.deepEqual(parseAgyModels(input).map(x=>x.id), ['gemini-3.8-flash-high','claude-sonnet-4-6','gpt-oss-120b']);
 assert.deepEqual(parseAgyModels('not model data').map(x=>x.id), []);
});
test('live model discovery uses agy models only; errors do not produce models',async()=>{
 const got=[];
 const models=await discoverAgyModels({config:{command:'/tmp/trusted-agy'}},async(cmd,args,opts)=>{
  got.push({cmd,args,opts});
  return {stdout:'gemini-3.1-pro-high     Gemini 3.1 Pro (High)\n'};
 }, 'linux');
 assert.equal(got[0].cmd,'/tmp/trusted-agy');
 assert.deepEqual(got[0].args,['models']);
 assert.equal(got[0].opts.shell,false);
 assert.equal(models[0].id,'gemini-3.1-pro-high');
 assert.equal(models.length,1);
 await assert.rejects(discoverAgyModels({config:{command:'/tmp/trusted-agy'}},async()=>{throw Error('failed');},'linux'),/discovery failed/);
 await assert.rejects(discoverAgyModels({config:{command:'/tmp/trusted-agy'}},async()=>({stdout:'',stderr:''}),'linux'),/no valid model/);
 const adapter=createServerAdapter();
 assert.deepEqual(adapter.models,[]);
 assert.equal(typeof adapter.listModels,'function');
 assert.equal(typeof adapter.refreshModels,'function');
});
test('macOS uses a pseudoterminal for the SAME agy models command',()=>{
 const spec = makeModelCommand('/Users/agent/.local/bin/agy','darwin');
 assert.equal(spec.command, 'python3');
 assert.equal(spec.args[0], '-u');
 assert.match(spec.args[1], /pty-models\.py$/);
 assert.equal(spec.args[2], '/Users/agent/.local/bin/agy');
});
test('rejects missing or default model in execution configuration',()=>{
 assert.throws(()=>normalizeConfig({cwd:'/tmp/a',allowedWorkspaceRoot:'/tmp/a'}),/explicit Antigravity model/);
 assert.throws(()=>normalizeConfig({cwd:'/tmp/a',allowedWorkspaceRoot:'/tmp/a',model:'default'}),/explicit Antigravity model/);
});
test('initial Paperclip onboarding missing workspace returns warn, real execution remains strict',async(t)=>{
 const f=await fixture(t);
 const res=await testEnvironment({config:{command:f.exe,probeAuthentication:false}});
 assert.equal(res.status,'warn');
 assert.ok(res.checks.some(x=>x.code==='workspace' && x.level==='warn'));
 assert.throws(()=>normalizeConfig({command:'agy'}),/absolute/);
});
test('formatToolProgress formats active tool and done states with bounded safe output',()=>{
 const active=formatToolProgress({
   step_type:'tool',
   state:'ACTIVE',
   tool_name:'run_command',
   tool_info:{parameters:{CommandLine:'pnpm --filter backend test'}}
 });
 assert.match(active,/\[tool:run_command\] pnpm --filter backend test/);

 const done=formatToolProgress({
   step_type:'tool',
   state:'DONE',
   tool_name:'run_command',
   duration_seconds:1.25,
   tool_info:{output:'Tests passed: 25\nAll green'}
 });
 assert.match(done,/Tests passed: 25/);
 assert.match(done,/\[tool:run_command done\] \(1\.25s\)/);

 const fileEdit=formatToolProgress({
   step_type:'tool',
   state:'ACTIVE',
   tool_name:'replace_file_content',
   tool_info:{parameters:{TargetFile:'/path/to/file.ts'}}
 });
 assert.match(fileEdit,/\[tool:replace_file_content\] \/path\/to\/file\.ts/);
});

test('estimateCostUsd calculates accurate token pricing across model tiers', () => {
  // Flash pricing: $0.10 / 1M in, $0.025 / 1M cached, $0.40 / 1M out
  const flashUsage = { inputTokens: 1_000_000, cachedInputTokens: 2_000_000, outputTokens: 500_000 };
  const flashCost = estimateCostUsd('gemini-3.8-flash-high', flashUsage);
  // 1.0 * 0.10 + 2.0 * 0.025 + 0.5 * 0.40 = 0.10 + 0.05 + 0.20 = 0.35
  assert.equal(flashCost, 0.35);

  // Pro pricing: $1.25 / 1M in, $0.3125 / 1M cached, $5.00 / 1M out
  const proUsage = { inputTokens: 200_000, cachedInputTokens: 3_800_000, outputTokens: 50_000 };
  const proCost = estimateCostUsd('gemini-3.1-pro-low', proUsage);
  // (200000 * 1.25 + 3800000 * 0.3125 + 50000 * 5.0) / 1e6 = 1.6875
  assert.equal(proCost, 1.6875);

  // Claude Sonnet: $3.00 / 1M in, $0.30 / 1M cached, $15.00 / 1M out
  const sonnetCost = estimateCostUsd('claude-3-5-sonnet', { inputTokens: 1_000_000, outputTokens: 100_000 });
  // 1.0 * 3.00 + 0.1 * 15.00 = 3.00 + 1.50 = 4.50
  assert.equal(sonnetCost, 4.5);

  // Edge cases: zero tokens, missing usage, snake_case keys
  assert.equal(estimateCostUsd('gemini-3.8-flash-high', { inputTokens: 0, outputTokens: 0 }), 0);
  assert.equal(estimateCostUsd('gemini-3.8-flash-high', null), null);
  assert.equal(estimateCostUsd('gemini-3.8-flash-high', { input_tokens: 1_000_000 }), 0.10);
});

test('auto-rotates to next ready account on quota exhaustion (429) and retries turn with original model', async (t) => {
  const f = await fixture(t);
  const acc1 = 'account1@example.com';
  const acc2 = 'account2@example.com';
  const token1 = makeMockToken(acc1);
  const token2 = makeMockToken(acc2);

  const pool = {
    version: 1,
    activeAccount: acc1,
    accounts: [
      { email: acc1, tokenPayload: token1, status: 'ready', expiry: '2099-01-01T00:00:00Z', quotaResetAt: null, lastUsedAt: null },
      { email: acc2, tokenPayload: token2, status: 'ready', expiry: '2099-01-01T00:00:00Z', quotaResetAt: null, lastUsedAt: null },
    ],
  };
  await writeFile(f.mockPoolFile, JSON.stringify(pool, null, 2));
  process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD = token1;

  const events = [];
  const { ctx, spawned } = fakeContext(f.config, 'SCENARIO_QUOTA_ONCE');
  ctx.onEvent = async (e) => events.push(e);

  const res = await executeWithHelpers(ctx, helpers);
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.equal(res.sessionParams.account, acc2);
  assert.equal(res.model, 'gemini-3.8-flash-low');
  assert.equal(spawned.length, 2);

  const autoSwitchEvt = events.find(e => e.eventType === 'account.auto_switched');
  assert.ok(autoSwitchEvt, 'account.auto_switched event must be emitted');
  assert.equal(autoSwitchEvt.payload.previousAccount, acc1);
  assert.equal(autoSwitchEvt.payload.currentAccount, acc2);
  assert.equal(autoSwitchEvt.payload.model, 'gemini-3.8-flash-low');
  assert.equal(process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD, token2);
});

test('pre-turn auto-switches to ready account if active account is on quota cooldown', async (t) => {
  const f = await fixture(t);
  const acc1 = 'account1@example.com';
  const acc2 = 'account2@example.com';
  const token1 = makeMockToken(acc1);
  const token2 = makeMockToken(acc2);

  const pool = {
    version: 1,
    activeAccount: acc1,
    accounts: [
      { email: acc1, tokenPayload: token1, status: 'quota_exhausted', expiry: '2099-01-01T00:00:00Z', quotaResetAt: Date.now() + 1800000, lastUsedAt: null },
      { email: acc2, tokenPayload: token2, status: 'ready', expiry: '2099-01-01T00:00:00Z', quotaResetAt: null, lastUsedAt: null },
    ],
  };
  await writeFile(f.mockPoolFile, JSON.stringify(pool, null, 2));
  process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD = token1;

  const events = [];
  const { ctx, spawned } = fakeContext(f.config, 'SCENARIO_OK');
  ctx.onEvent = async (e) => events.push(e);

  const res = await executeWithHelpers(ctx, helpers);
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.equal(res.sessionParams.account, acc2);
  assert.equal(spawned.length, 1);

  const autoSwitchEvt = events.find(e => e.eventType === 'account.auto_switched');
  assert.ok(autoSwitchEvt, 'account.auto_switched event must be emitted before dispatch');
  assert.equal(autoSwitchEvt.payload.previousAccount, acc1);
  assert.equal(autoSwitchEvt.payload.currentAccount, acc2);
  assert.equal(process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD, token2);
});

test('fails with provider_quota when all accounts in pool are exhausted', async (t) => {
  const f = await fixture(t);
  const acc1 = 'account1@example.com';
  const acc2 = 'account2@example.com';
  const token1 = makeMockToken(acc1);
  const token2 = makeMockToken(acc2);

  const pool = {
    version: 1,
    activeAccount: acc1,
    accounts: [
      { email: acc1, tokenPayload: token1, status: 'ready', expiry: '2099-01-01T00:00:00Z', quotaResetAt: null, lastUsedAt: null },
      { email: acc2, tokenPayload: token2, status: 'ready', expiry: '2099-01-01T00:00:00Z', quotaResetAt: null, lastUsedAt: null },
    ],
  };
  await writeFile(f.mockPoolFile, JSON.stringify(pool, null, 2));
  process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD = token1;

  const { ctx, spawned } = fakeContext(f.config, 'SCENARIO_QUOTA');
  const res = await executeWithHelpers(ctx, helpers);

  assert.notEqual(res.exitCode, 0);
  assert.equal(res.errorCode, 'provider_quota');
  assert.match(res.errorMessage, /all available antigravity accounts exhausted quota/i);
  assert.equal(spawned.length, 2);
});
