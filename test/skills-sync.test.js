import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, symlink, access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fixture, fakeContext, helpers ,testDeps} from './fixtures.js';
import { createServerAdapter } from '../src/server/index.js';
import { buildPrompt, executeWithHelpers } from '../src/server/execute.js';
import { listSkills, syncSkills, stageAssignedSkills } from '../src/lib/skills.js';

async function makeSkills(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'paperclip-skills-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries=[];
  for (const name of ['governance','prisma','not-selected']) {
    const source = path.join(root,name);
    await mkdir(path.join(source,'references'), { recursive:true });
    await writeFile(path.join(source,'SKILL.md'), `---\nname: ${name}\ndescription: Guidance for ${name}\n---\n\n# ${name}\nRead only when relevant.\n`);
    await writeFile(path.join(source,'references','notes.md'),`${name} notes`);
    entries.push({ key:`company/test/${name}`, runtimeName:name,source });
  }
  return { root, entries, desired: entries.slice(0,2).map(e => e.key) };
}
function configWithSkills(config,s) {
 return {...config,paperclipSkillSync:{desiredSkills:s.desired},paperclipRuntimeSkills:s.entries};
}
test('advertises real Paperclip skills and materialization capability',()=>{
 const adapter = createServerAdapter();
 assert.equal(typeof adapter.listSkills,'function');
 assert.equal(typeof adapter.syncSkills,'function');
 assert.equal(adapter.requiresMaterializedRuntimeSkills,true);
});
test('snapshots contain ONLY assigned, existing skills and have ephemeral mode',async t=>{
 const s=await makeSkills(t); const cfg=configWithSkills({},s);
 const snap=await listSkills({adapterType:'antigravity_local',config:cfg});
 assert.equal(snap.mode,'ephemeral');assert.equal(snap.supported,true);
 assert.deepEqual(snap.desiredSkills,s.desired);
 assert.deepEqual(snap.entries.map(e=>e.runtimeName),['governance','prisma']);
 assert.ok(snap.entries.every(e=>e.state==='installed'));
 assert.deepEqual(snap.warnings,[]);
 const updated=await syncSkills({adapterType:'antigravity_local',config:cfg},[s.entries[1].key]);
 assert.deepEqual(updated.entries.map(e=>e.runtimeName),['prisma']);
});
test('stages only selected skill directories and removes them safely', async t=>{
 const s=await makeSkills(t);
 const bundle=await stageAssignedSkills(configWithSkills({},s));
 const skillsDir=path.join(bundle.root,'.agents','skills');
 await access(path.join(skillsDir,'governance','references','notes.md'));
 await access(path.join(skillsDir,'prisma','SKILL.md'));
 await assert.rejects(access(path.join(skillsDir,'not-selected','SKILL.md')));
 assert.match(bundle.index,/governance/);
 assert.match(bundle.index,/read its SKILL.md/);
 assert.ok(bundle.index.length<1200);
 await bundle.cleanup();
 await assert.rejects(access(bundle.root));
});
test('planning agent receives staged skill path for CLI and cleans after completion',async t=>{
 const f=await fixture(t);const s=await makeSkills(t);
 const {ctx}=fakeContext(configWithSkills(f.config,s));
 let root,seen=false;
 ctx.onMeta=async meta=>{
   const i=meta.commandArgs.indexOf('--add-dir');
   assert.ok(i>=0,'Antigravity was not given the skill directory');
   root=meta.commandArgs[i+1];
   assert.equal(meta.cwd,await (await import('node:fs/promises')).realpath(f.secondary));
   await access(path.join(root,'.agents','skills','governance','SKILL.md'));
   await access(path.join(root,'.agents','skills','prisma','references','notes.md'));
   await assert.rejects(access(path.join(root,'.agents','skills','not-selected','SKILL.md')));
   seen=true;
 };
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.exitCode,0,JSON.stringify(result));
 assert.equal(seen,true);
 await assert.rejects(access(root),'skill staging must be gone after the command');
});
test('missing assigned skill fails closed BEFORE dispatch',async t=>{
 const f=await fixture(t); const s=await makeSkills(t);
 const cfg=configWithSkills(f.config,s);
 cfg.paperclipRuntimeSkills=[s.entries[0]];
 const snap=await listSkills({adapterType:'antigravity_local',config:cfg});
 assert.equal(snap.entries[1].state,'missing');
 const {ctx,spawned}=fakeContext(cfg);
 const outcome=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(outcome.exitCode,0);
 assert.match(outcome.errorMessage,/Assigned skill.*unavailable/);
 assert.equal(spawned.length,0);
});
test('rejects duplicate names and path traversal in Paperclip-controlled skill names',async t=>{
 const s=await makeSkills(t);
 const traversal={...s.entries[0],runtimeName:'../outside'};
 await assert.rejects(stageAssignedSkills({paperclipSkillSync:{desiredSkills:[traversal.key]},paperclipRuntimeSkills:[traversal]}),/unavailable|Invalid runtime/);
 await assert.rejects(stageAssignedSkills({paperclipSkillSync:{desiredSkills:s.desired},paperclipRuntimeSkills:s.entries.map(e=>e.runtimeName==='prisma'?{...e,runtimeName:'governance'}:e)}),/Conflicting runtime/);
});
test('rejects symlink inside a skill and does not leave staging root',async t=>{
 const s=await makeSkills(t);
 const leak=path.join(s.entries[0].source,'references','leak');
 await symlink(path.join(s.root,'unrelated-secret'),leak);
 await assert.rejects(stageAssignedSkills({paperclipSkillSync:{desiredSkills:[s.entries[0].key]},paperclipRuntimeSkills:s.entries}),/Unsupported file type/);
});
test('base prompt carries bounded, on-demand skill index without entire skill body',async t=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config);
 const prompt=buildPrompt(ctx,{...f.config,executionMode:'planning',maxPromptBytes:500000},'',helpers,'## Skills assigned by Paperclip\n- prisma: /tmp/skills/prisma/SKILL.md');
 assert.match(prompt,/Skills assigned by Paperclip/);
 assert.match(prompt,/prisma\/SKILL.md/);
});
test('cleans staged skills even when Antigravity returns an execution error',async t=>{
 const f=await fixture(t);const s=await makeSkills(t);
 const {ctx}=fakeContext(configWithSkills(f.config,s),'SCENARIO_ERROR');
 let stageRoot='';
 ctx.onMeta=async meta=>{const n=meta.commandArgs.indexOf('--add-dir');stageRoot=meta.commandArgs[n+1];};
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(result.exitCode,0);
 assert.ok(stageRoot);
 await assert.rejects(access(stageRoot));
});
test('keeps trusted script execute permission in ephemeral bundle and never writes repository',async t=>{
 const f=await fixture(t);const s=await makeSkills(t);
 const sourceScript=path.join(s.entries[0].source,'scripts','check.sh');
 await mkdir(path.dirname(sourceScript));
 await writeFile(sourceScript,'#!/bin/sh\nprintf OK\n',{mode:0o755});
 const cfg=configWithSkills(f.config,s);
 const bundle=await stageAssignedSkills(cfg);
 const {stat}=await import('node:fs/promises');
 assert.ok((await stat(path.join(bundle.root,'.agents','skills','governance','scripts','check.sh'))).mode & 0o100);
 await bundle.cleanup();
 await assert.rejects(access(path.join(f.secondary,'.agents','skills','governance')));
});
test('buildPrompt includes Graphify knowledge base, epic context, and cross-agent collaboration',async t=>{
 const f=await fixture(t);
 const {ctx}=fakeContext(f.config);
 ctx.context={
  taskId:'issue-100',identifier:'BUC-100',taskTitle:'Wire webhook handler',priority:'high',
  parentId:'epic-14',parentTitle:'Billing & Wallet',
  parentDescription:'Product pillar: Razorpay wallet and payment integrity',
  dependencies:['BUC-99 (database migration)'],
  taskDescription:'Implement idempotency checks',wakeReason:'assigned',
 };
 const prompt=buildPrompt(ctx,{...f.config,executionMode:'implementation',maxPromptBytes:500000},'Do the work',helpers,'',{graphifyAvailable:true});
 assert.match(prompt,/Codebase Knowledge Graph \(Graphify\)/);
 assert.match(prompt,/graphify query "<question>"/);
 assert.match(prompt,/Parent epic title: Billing & Wallet/);
 assert.match(prompt,/Upstream blockers \/ dependencies: BUC-99 \(database migration\)/);
 assert.match(prompt,/Cross-Agent Squad Collaboration & Context Sharing/);
 assert.match(prompt,/Delivery Lead coordinates assignments/);
});
