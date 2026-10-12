import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fixture, fakeContext, helpers, testDeps} from './fixtures.js';
import {executeWithHelpers} from '../src/server/execute.js';

test('model validation uses an injected model list in tests and keeps production default live', async t => {
  const f = await fixture(t);
  const {ctx, spawned} = fakeContext(f.config);
  let calls=0;
  const result=await executeWithHelpers(ctx,helpers,{discoverModels:async ({config})=>{
    calls++;
    assert.equal(config.command,f.exe);
    return [{id:config.model,label:'Fixture catalog'}];
  }});
  assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.equal(calls,1);
  assert.equal(spawned.length,1);
});

test('reject remote execution before consulting external model discovery',async t=>{
  const f=await fixture(t);
  const {ctx,spawned}=fakeContext(f.config);
  ctx.executionTarget={kind:'remote'};
  let calls=0;
  const result=await executeWithHelpers(ctx,helpers,{discoverModels:async ()=>{calls++;throw Error('must not call');}});
  assert.match(result.errorMessage,/Only local execution/);
  assert.equal(calls,0);
  assert.equal(spawned.length,0);
});

test('planning dirty worktree fails without slow model lookup',async t=>{
  const f=await fixture(t);
  const {ctx,spawned}=fakeContext(f.config);
  await writeFile(path.join(f.secondary,'dirty.file'),'content');
  let calls=0;
  const result=await executeWithHelpers(ctx,helpers,{discoverModels:async ()=>{calls++;throw Error('must not call');}});
  assert.match(result.errorMessage,/clean worktree/);
  assert.equal(calls,0);
  assert.equal(spawned.length,0);
});

test('removed models fail closed without running a model turn',async t=>{
  const f=await fixture(t);
  const {ctx,spawned}=fakeContext({...f.config,model:'unknown-model'});
  const result=await executeWithHelpers(ctx,helpers,testDeps);
  assert.match(result.errorMessage,/no longer available/);
  assert.equal(spawned.length,0);
});
