import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {fixture,fakeContext,helpers,testDeps} from './fixtures.js';
import {executeWithHelpers,buildPrompt} from '../src/server/execute.js';
import {normalizeConfig} from '../src/lib/config.js';
import {sessionCodec} from '../src/lib/result.js';

async function run(ctx) {
  const result = await executeWithHelpers(ctx,helpers,testDeps);
  assert.equal(result.exitCode,0,JSON.stringify(result));
  return result;
}

test('reconciled recovery refreshes continuation guidance in full and compact prompts', async t=>{
  const f=await fixture(t);const {ctx}=fakeContext(f.config);
  ctx.context.previousRunId='interrupted-run';
  ctx.context.recoveryActionId='recovery-action';
  for (const compactResume of [false,true]) {
    const prompt=buildPrompt(ctx,normalizeConfig(f.config),'',helpers,'',{compactResume});
    assert.match(prompt,/Previous run: interrupted-run/);
    assert.match(prompt,/Recovery action: recovery-action/);
    assert.match(prompt,/verify outcomes before repeating writes/);
    assert.match(prompt,/do not reuse paths from the interrupted conversation/);
  }
  delete ctx.context.previousRunId;
  ctx.context.retryOfRunId='fallback-run';
  assert.match(buildPrompt(ctx,normalizeConfig(f.config),'',helpers),/Previous run: fallback-run/);
  delete ctx.context.retryOfRunId;
  assert.doesNotMatch(buildPrompt(ctx,normalizeConfig(f.config),'',helpers),/Reconciled execution continuation/);
});

test('resumed AGY session does not resend unchanged long instructions and parent task',async t=>{
  const f=await fixture(t);
  const instructions=path.join(f.root,'role.md');
  await writeFile(instructions,'Strict role instructions. '.repeat(200));
  const {ctx}=fakeContext({...f.config,instructionsFilePath:instructions});
  ctx.context.taskDescription='Core feature scope '.repeat(120);
  ctx.context.parentDescription='Large parent epic '.repeat(120);
  const first=await run(ctx);
  assert.equal(first.resultJson.promptStats.mode,'full');
  ctx.runtime.sessionParams=first.sessionParams;
  const second=await run(ctx);
  assert.equal(second.resultJson.promptStats.mode,'compact_resume');
  assert.ok(second.resultJson.promptStats.bytes < first.resultJson.promptStats.bytes*0.25,
    `expected >75% prompt reduction; first=${first.resultJson.promptStats.bytes} second=${second.resultJson.promptStats.bytes}`);
  assert.equal(first.sessionParams.promptSignature,second.sessionParams.promptSignature);
});

test('a task description change is sent while remaining on the verified session',async t=>{
  const f=await fixture(t); const {ctx}=fakeContext(f.config);
  const first=await run(ctx);ctx.runtime.sessionParams=first.sessionParams;
  const unchanged=await run(ctx);ctx.runtime.sessionParams=unchanged.sessionParams;
  ctx.context.taskDescription='New acceptance requirement added by user';
  const updated=await run(ctx);
  assert.equal(updated.resultJson.promptStats.mode,'compact_resume');
  assert.ok(updated.resultJson.promptStats.bytes > unchanged.resultJson.promptStats.bytes);
  assert.notEqual(updated.sessionParams.contextFingerprint,unchanged.sessionParams.contextFingerprint);
});

test('modified approved agent instructions invalidate compact reuse and start a fresh AGY conversation',async t=>{
  const f=await fixture(t);const instructions=path.join(f.root,'role.md');
  await writeFile(instructions,'Phase one policy');
  const {ctx}=fakeContext({...f.config,instructionsFilePath:instructions});
  const first=await run(ctx);ctx.runtime.sessionParams=first.sessionParams;
  await writeFile(instructions,'Changed policy, requiring fresh conversation');
  let meta;
  ctx.onMeta=async m=>{meta=m;};
  const second=await run(ctx);
  assert.equal(second.resultJson.promptStats.mode,'full');
  assert.equal(meta.commandArgs.includes('--conversation'),false);
  assert.notEqual(first.sessionParams.promptSignature,second.sessionParams.promptSignature);
});

test('legacy full_every_turn mode remains available for safe rollout comparison',async t=>{
  const f=await fixture(t);const {ctx}=fakeContext({...f.config,promptPolicy:'full_every_turn'});
  const first=await run(ctx);ctx.runtime.sessionParams=first.sessionParams;
  const second=await run(ctx);
  assert.equal(second.resultJson.promptStats.mode,'full');
  assert.equal(second.resultJson.promptStats.bytes,first.resultJson.promptStats.bytes);
  assert.throws(()=>normalizeConfig({...f.config,promptPolicy:'unknown'}),/promptPolicy/);
});

test('ephemeral skill staging directory may change without forcing fresh AGY session',async t=>{
  const f=await fixture(t);
  const source=path.join(f.root,'governance');await mkdir(source);
  await writeFile(path.join(source,'SKILL.md'),'---\ndescription: Skill guidance\n---\nUse approved rules.');
  const config={...f.config,paperclipSkillSync:{desiredSkills:['company/governance']},
    paperclipRuntimeSkills:[{key:'company/governance',runtimeName:'governance',source}]};
  const {ctx}=fakeContext(config);
  const first=await run(ctx);ctx.runtime.sessionParams=first.sessionParams;
  const second=await run(ctx);
  assert.equal(second.resultJson.promptStats.mode,'compact_resume');
  assert.equal(second.sessionParams.promptSignature,first.sessionParams.promptSignature);
});

test('Paperclip session codec preserves context and instruction fingerprints',async t=>{
  const f=await fixture(t);const {ctx}=fakeContext(f.config);
  const first=await run(ctx);
  const restored=sessionCodec.deserialize(sessionCodec.serialize(first.sessionParams));
  assert.equal(restored.promptSignature,first.sessionParams.promptSignature);
  assert.equal(restored.contextFingerprint,first.sessionParams.contextFingerprint);
  ctx.runtime.sessionParams=restored;
  const second=await run(ctx);
  assert.equal(second.resultJson.promptStats.mode,'compact_resume');
});
