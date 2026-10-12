import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {runMinimalProbe, parseProbeResult, probeWithCache, clearProbeCacheForTests} from '../src/lib/probe.js';
import {testEnvironment} from '../src/server/test.js';
import {fixture} from './fixtures.js';

const ok = JSON.stringify({status:'SUCCESS', response:'OK',usage:{input_tokens:14,output_tokens:2,total_tokens:16}});

test('minimal probe uses isolated empty directory, selected model, bounded JSON and no unsafe flags', async()=>{
  let caught={};
  const result=await runMinimalProbe({command:'/path/agy',model:'gemini-3.8-flash-medium',timeoutSec:12},async(cmd,args,opts)=>{
    caught={cmd,args,opts};
    assert.equal(cmd,'/path/agy');
    assert.equal(opts.shell,false);
    assert.ok(args.includes('--sandbox'));
    assert.ok(args.includes('--model'));
    assert.equal(args[args.indexOf('--model')+1],'gemini-3.8-flash-medium');
    assert.ok(args.includes('--output-format'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(!opts.cwd.includes('wacrm'));
    const fs=await import('node:fs/promises');
    assert.deepEqual(await fs.readdir(opts.cwd),[]);
    return {stdout:ok,stderr:''};
  });
  assert.equal(result.ok,true);
  assert.equal(result.tokens.totalTokens,16);
  await assert.rejects(access(caught.opts.cwd));
});

test('minimal probe has strict result validation and checks soft permission denials',()=>{
  assert.deepEqual(parseProbeResult('garbage').ok,false);
  assert.equal(parseProbeResult(JSON.stringify({status:'ERROR',response:''})).ok,false);
  assert.equal(parseProbeResult(JSON.stringify({status:'WAITING',response:''})).ok,false);
  assert.equal(parseProbeResult(ok,'Tool permission denied by policy').ok,false);
  assert.equal(parseProbeResult(ok).ok,true);
  assert.equal(parseProbeResult(JSON.stringify({status:'SUCCESS',response:'Unexpected nontrivial reply'})).ok,false);
  assert.equal(parseProbeResult(ok,'',1).ok,false);
});

test('failed probe reports clear failure and never pretends authentication works',async()=>{
  const result=await runMinimalProbe({command:'/path/agy',model:'gemini-3.8-flash-low',timeoutSec:12},async()=>{throw Object.assign(Error('boom'),{code:'ETIMEDOUT'});});
  assert.equal(result.ok,false);
  assert.match(result.reason,/timed out/);
});

test('successful probes cached for 15 minutes and deduplicated for same model',async()=>{
  clearProbeCacheForTests();
  let calls=0;let now=1_000_000;
  const runner=async()=>{calls++;await new Promise(r=>setTimeout(r,15));return {stdout:ok,stderr:''};};
  const cfg={command:'/path/agy',model:'gemini-3.8-flash-low',probeTimeoutSec:11};
  const [a,b]=await Promise.all([probeWithCache(cfg,runner,()=>now),probeWithCache(cfg,runner,()=>now)]);
  assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(calls,1);
  const c=await probeWithCache(cfg,runner,()=>now);
  assert.equal(c.cached,true);assert.equal(calls,1);
  now+=15*60*1000+1;
  await probeWithCache(cfg,runner,()=>now);
  assert.equal(calls,2);
  await probeWithCache({...cfg,model:'gemini-3.8-flash-high'},runner,()=>now);
  assert.equal(calls,3);
  clearProbeCacheForTests();
});

test('unconfigured onboarding probes with few tokens but does not claim workspace readiness', async(t)=>{
  const f=await fixture(t);
  const r=await testEnvironment({config:{command:f.exe,probeAuthentication:true,model:'gemini-3.8-flash-low'}}, {
    probe:async()=>({ok:true,tokens:{totalTokens:16}}),
  });
  assert.equal(r.status,'warn');
  assert.ok(r.checks.some(c=>c.code==='auth'&&c.level==='info'&&c.message.includes('16 total tokens')));
  assert.ok(r.checks.some(c=>c.code==='workspace'&&c.level==='warn'));
});

test('environment test reports failed live probe as an error',async(t)=>{
  const f=await fixture(t);
  const r=await testEnvironment({config:{command:f.exe,probeAuthentication:true,model:'gemini-3.8-flash-low'}}, {
    probe:async()=>({ok:false,reason:'Model quota exhausted.'}),
  });
  assert.equal(r.status,'fail');
  assert.ok(r.checks.some(c=>c.code==='auth'&&c.level==='error'));
});

test('model probe never executes without an explicit model', async()=>{
 await assert.rejects(runMinimalProbe({command:'/path/agy',model:'default'}),/explicit Antigravity model/);
 await assert.rejects(runMinimalProbe({command:'/path/agy'}),/explicit Antigravity model/);
});
