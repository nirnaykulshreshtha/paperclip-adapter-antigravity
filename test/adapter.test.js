import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, realpath, symlink} from 'node:fs/promises';
import path from 'node:path';
import {fixture,fakeContext,helpers,makeMockToken,testDeps} from './fixtures.js';
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
 const r=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(r.exitCode,0,JSON.stringify(r));
 assert.equal(r.sessionParams.conversationId,'abcde-123');
 assert.equal(r.usage.inputTokens,123);
 assert.equal(r.usageBasis,'per_run');
 assert.equal(r.costStatus,'unpriced');
 assert.equal(r.costUsd,undefined);
 assert.equal(r.billingType,'external_cli_unverified');
 assert.equal(r.biller,'antigravity');
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
 const resumed=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(resumed.exitCode,0,JSON.stringify(resumed));
 assert.equal(resumed.sessionParams.cwd,await realpath(f.secondary));
 ctx.runtime.sessionParams={conversationId:'abcde-123',cwd:f.primary,taskKey:'task-123'};
 const r=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(r.exitCode,0);
 assert.match(r.errorMessage,/another workspace/);
 ctx.runtime.sessionParams={conversationId:'abcde-123',cwd:alias,taskKey:'another-task'};
 const wrongTask=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(wrongTask.exitCode,0);
 assert.match(wrongTask.errorMessage,/another workspace or task/);
});
test('fails closed for CLI ERROR, malformed output, missing final result and permission denial',async(t)=>{
 const f=await fixture(t);
 for(const label of ['SCENARIO_ERROR','SCENARIO_MALFORMED','SCENARIO_NO_RESULT','SCENARIO_SOFT_DENY','SCENARIO_AUTO_APPROVE']){
  const {ctx}=fakeContext(f.config,label);
  if (label === 'SCENARIO_AUTO_APPROVE') ctx.config.allowUnattendedRuntime = false;
  const r=await executeWithHelpers(ctx, helpers, testDeps);
  assert.notEqual(r.exitCode,0,`${label}: ${JSON.stringify(r)}`);
 }
});
test('quota / token limit failure classifies provider_quota and clears session', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_QUOTA');
 const r=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(r.exitCode,0);
 assert.equal(r.errorCode,'provider_quota');
 assert.equal(r.resultJson?.errorFamily,'provider_quota');
 assert.equal(r.clearSession,true);
 assert.match(r.errorMessage,/token limit \/ quota reached/i);
});
test('auth failure classifies provider_auth_error and clears session', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_AUTH_FAIL');
 const r=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(r.exitCode,0);
 assert.equal(r.errorCode,'provider_auth_error');
 assert.equal(r.resultJson?.errorFamily,'auth');
 assert.equal(r.clearSession,true);
 assert.match(r.errorMessage,/authentication/i);
});
test('turn limit hit classifies agent_turn_limit_reached and retains session', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_TURN_LIMIT');
 const r=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(r.exitCode,53);
 assert.equal(r.errorCode,'agent_turn_limit_reached');
 assert.equal(r.resultJson?.errorFamily,'execution');
 assert.equal(r.clearSession,false);
 assert.match(r.errorMessage,/turn limit/i);
});
test('unclassified error includes first line of stderr in error message', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_UNCLASSIFIED');
 const r=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(r.exitCode,0);
 assert.match(r.errorMessage,/fatal: custom execution error occurred/);
});
test('failure during conversation resume automatically clears session', async(t)=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config,'SCENARIO_FAIL_RESUME');
 ctx.runtime.sessionParams={conversationId:'abcde-123',cwd:f.secondary,taskKey:'task-123'};
 const r=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(r.exitCode,0);
 assert.equal(r.clearSession,true);
});
test('planning detects unexpected file creation',async(t)=>{
 const f=await fixture(t);const {ctx}=fakeContext(f.config,'SCENARIO_WRITE');
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(result.exitCode,0);
 assert.match(result.errorMessage,/modified the worktree/);
});
test('planning fails before CLI spawn on dirty tree',async(t)=>{
 const f=await fixture(t);await writeFile(path.join(f.secondary,'dirty.txt'),'dirty');
 const {ctx,spawned}=fakeContext(f.config);const r=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(r.exitCode,0);assert.equal(spawned.length,0);
});
test('cancels child process and returns failure',async(t)=>{
 const f=await fixture(t);const {ctx}=fakeContext(f.config,'SCENARIO_HANG');
 const ac=new AbortController();ctx.signal=ac.signal;
 setTimeout(()=>ac.abort(),350);
 const r=await executeWithHelpers(ctx, helpers, testDeps);
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

test('pricing calculator uses explicit provider usage and precise catalog rates, never model-family defaults', async () => {
 const catalog={models:{'gemini/gemini-3.8-flash-high':{
   litellm_provider:'gemini',mode:'chat',input_cost_per_token:'0.000001',
   cache_read_input_token_cost:'0.00000025',output_cost_per_token:'0.000004'}}};
 const cost=await estimateCostUsd({provider:'gemini',model:'gemini-3.8-flash-high',
   response:{usageMetadata:{promptTokenCount:3000000,cachedContentTokenCount:2000000,
     candidatesTokenCount:500000}},pricingCatalog:catalog});
 assert.equal(cost.costUsdExact,'3.5');
 await assert.rejects(estimateCostUsd({provider:'gemini',model:'unsupported-model',
   response:{usageMetadata:{promptTokenCount:1,candidatesTokenCount:1}},pricingCatalog:catalog}),
   /No exact/);
});

test('quota error does not silently rotate an AGY account or replay a side-effectful turn',async(t)=>{
 const f=await fixture(t);const email='current@example.com';
 const token=makeMockToken(email);
 process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD=token;
 const {ctx,spawned}=fakeContext(f.config,'SCENARIO_QUOTA');
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.errorCode,'provider_quota');
 assert.equal(spawned.length,1);
 assert.equal(process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD,token);
});

test('account observation never auto-switches to a different account despite a previous cooldown',async(t)=>{
 const f=await fixture(t);const email='current@example.com';
 const token=makeMockToken(email);
 process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD=token;
 const {ctx,spawned}=fakeContext(f.config);
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.exitCode,0);
 assert.equal(result.sessionParams.account,email);
 assert.equal(spawned.length,1);
 assert.equal(process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD,token);
});

test('one quota error is accurately classified without claiming that all accounts have failed',async(t)=>{
 const f=await fixture(t);const {ctx,spawned}=fakeContext(f.config,'SCENARIO_QUOTA');
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.errorCode,'provider_quota');
 assert.doesNotMatch(result.errorMessage,/all available/i);
 assert.equal(spawned.length,1);
});

test('account pool operations strictly respect custom filePath and do not modify default pool', async (t) => {
  const f = await fixture(t);
  const acc = 'isolated@example.com';
  const token = makeMockToken(acc);
  const pool = {
    version: 1,
    activeAccount: acc,
    accounts: [
      { email: acc, tokenPayload: token, status: 'ready', expiry: '2099-01-01T00:00:00Z', quotaResetAt: null, lastUsedAt: null },
    ],
  };
  await writeFile(f.mockPoolFile, JSON.stringify(pool, null, 2));

  const { loadAccountPool, markAccountQuotaExhausted } = await import('../src/lib/account-pool.js');
  const loaded = await loadAccountPool(f.mockPoolFile);
  assert.equal(loaded._filePath, f.mockPoolFile);

  await markAccountQuotaExhausted(acc, loaded, 60000, 'test cooldown', f.mockPoolFile);
  const reloaded = JSON.parse(await readFile(f.mockPoolFile, 'utf8'));
  assert.equal(reloaded.accounts[0].status, 'quota_exhausted');
});

test('individual model quota exhaustion segregates model cooldown and leaves gemini operational', async (t) => {
  const f = await fixture(t);
  const acc = 'mixed@example.com';
  const token = makeMockToken(acc);
  const pool = {
    version: 1,
    activeAccount: acc,
    accounts: [
      { email: acc, tokenPayload: token, status: 'ready', expiry: '2099-01-01T00:00:00Z', quotaResetAt: null, lastUsedAt: null },
    ],
  };
  await writeFile(f.mockPoolFile, JSON.stringify(pool, null, 2));

  const { loadAccountPool, markAccountQuotaExhausted, getNextReadyAccount, isAccountReadyForModel } = await import('../src/lib/account-pool.js');
  const loaded = await loadAccountPool(f.mockPoolFile);

  // Simulate Claude hitting its individual quota
  await markAccountQuotaExhausted(acc, loaded, 1800000, 'error: Individual quota reached. Resets in 3h.', f.mockPoolFile, 'claude-sonnet-4-6');
  const reloaded = JSON.parse(await readFile(f.mockPoolFile, 'utf8'));

  // Account status remains ready because only Claude was exhausted
  assert.equal(reloaded.accounts[0].status, 'ready');
  assert.ok(reloaded.accounts[0].modelQuotas['claude-sonnet-4-6'].quotaResetAt > Date.now());

  // Ready for Gemini Pro and Flash
  assert.equal(isAccountReadyForModel(reloaded.accounts[0], 'gemini-3.1-pro-low'), true);
  assert.equal(isAccountReadyForModel(reloaded.accounts[0], 'gemini-3.8-flash-high'), true);

  // NOT ready for Claude Sonnet
  assert.equal(isAccountReadyForModel(reloaded.accounts[0], 'claude-sonnet-4-6'), false);

  // Pool candidate resolution respects model segregation
  const geminiCandidate = getNextReadyAccount(reloaded, null, 'gemini-3.1-pro-low');
  assert.ok(geminiCandidate);
  assert.equal(geminiCandidate.email, acc);

  const claudeCandidate = getNextReadyAccount(reloaded, null, 'claude-sonnet-4-6');
  assert.equal(claudeCandidate, null);
});

