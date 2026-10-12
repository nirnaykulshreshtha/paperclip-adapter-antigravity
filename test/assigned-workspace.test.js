import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, fakeContext, helpers ,testDeps} from './fixtures.js';
import { resolveAssignedWorkspace } from '../src/lib/assigned-workspace.js';
import { executeWithHelpers } from '../src/server/execute.js';
import { normalizeConfig } from '../src/lib/config.js';
import { testEnvironment } from '../src/server/test.js';
import { sessionCodec } from '../src/lib/result.js';
const exec=promisify(execFile);

async function dynamicSetup(t, {mode='planning'}={}) {
  const f=await fixture(t);
  await writeFile(path.join(f.root,'.paperclip-antigravity-allow'),'ALLOW_PAPERCLIP_ANTIGRAVITY_LOCAL\n');
  const config={...f.config,cwd:f.primary,repositoryRoot:f.primary,
    allowedWorkspaceRoot:f.root,workspaceMode:'paperclip',executionMode:mode,
    enableImplementation:mode==='implementation',
    approvedIssueIds:mode==='implementation'?['task-123']:[]};
  const {ctx,logs,spawned}=fakeContext(config);
  ctx.context.paperclipWorkspace={cwd:f.secondary,workspaceId:'ws-123',source:'issue_checkout',strategy:'git_worktree'};
  return {f,config,ctx,logs,spawned};
}

test('Paperclip dynamic checkout overrides configured cwd and selects validated branch',async t=>{
 const {f,config,ctx,spawned}=await dynamicSetup(t);
 const resolved=await resolveAssignedWorkspace(ctx,normalizeConfig(config));
 assert.equal(resolved.cwd,await realpath(f.secondary));
 assert.equal(resolved.workspaceId,'ws-123');
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.exitCode,0,JSON.stringify(result));
 assert.equal(result.sessionParams.workspaceId,'ws-123');
 assert.equal(result.sessionParams.cwd,await realpath(f.secondary));
 assert.equal(spawned.length,1);
});

test('canonicalizes symlinked worktree paths and safely resumes the same issue',async t=>{
 const {f,ctx}=await dynamicSetup(t);
 const alias=path.join(f.root,'pilot-alias');
 await symlink(f.secondary,alias,'dir');
 ctx.context.paperclipWorkspace.cwd=alias;
 const resolved=await resolveAssignedWorkspace(ctx,normalizeConfig(ctx.config));
 assert.equal(resolved.cwd,await realpath(f.secondary));
 const first=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(first.exitCode,0,JSON.stringify(first));
 assert.equal(first.sessionParams.cwd,resolved.cwd);
 ctx.runtime.sessionParams=first.sessionParams;
 ctx.context.paperclipWorkspace.cwd=f.secondary;
 const second=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(second.exitCode,0,JSON.stringify(second));
});

test('dynamic checkout ignores configured primary cwd and uses Paperclip source only',async t=>{
 const {f,ctx}=await dynamicSetup(t);
 const old=ctx.config.cwd;
 assert.equal(old,f.primary);
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.exitCode,0,JSON.stringify(result));
});

test('Paperclip dynamic mode fails closed without task workspace and without marker',async t=>{
 const {f,ctx,spawned}=await dynamicSetup(t);
 delete ctx.context.paperclipWorkspace;
 let result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(result.exitCode,0);
 assert.match(result.errorMessage,/did not supply an execution workspace/i);
 assert.equal(spawned.length,0);
 ctx.context.paperclipWorkspace={cwd:f.secondary,workspaceId:'ws-123'};
 await writeFile(path.join(f.root,'.paperclip-antigravity-allow'),'not authorized');
 result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(result.errorMessage,/marker/);
 assert.equal(spawned.length,0);
});

test('rejects primary checkout, unrelated repo, and unregistered secondary paths',async t=>{
 const {f,ctx,config,spawned}=await dynamicSetup(t);
 ctx.context.paperclipWorkspace.cwd=f.primary;
 let result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(result.errorMessage,/primary checkout/);
 const stranger=path.join(f.root,'stranger');
 await exec('git',['init','-q','-b','pilot/stranger',stranger]);
 ctx.context.paperclipWorkspace.cwd=stranger;
 result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(result.errorMessage,/different Git repository/);
 const unregistered=path.join(f.root,'unregistered');
 await mkdir(unregistered);
 ctx.context.paperclipWorkspace.cwd=unregistered;
 result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(result.exitCode,0);
 assert.equal(spawned.length,0);
});

test('rejects symlink escape and primary repo misconfiguration',async t=>{
 const {f,ctx,config}=await dynamicSetup(t);
 const outside=path.join(f.root,'elsewhere'); await mkdir(outside);
 const alias=path.join(f.secondary,'link-out');
 await symlink(outside,alias,'dir');
 ctx.context.paperclipWorkspace.cwd=alias;
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.notEqual(result.exitCode,0);
 ctx.context.paperclipWorkspace.cwd=f.secondary;
 config.repositoryRoot=outside;
 assert.notEqual((await executeWithHelpers(ctx, helpers, testDeps)).exitCode,0);
});

test('task & workspace session isolation survives cross-worktree changes',async t=>{
 const {f,ctx,config}=await dynamicSetup(t);
 const first=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(first.exitCode,0,JSON.stringify(first));
 const session=first.sessionParams;
 assert.equal(sessionCodec.deserialize(session).workspaceId,'ws-123');
 ctx.runtime.sessionParams={...session,workspaceId:'different-id'};
 let res=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(res.errorMessage,/another workspace or task/);
 ctx.runtime.sessionParams={...session,taskKey:'other-task'};
 res=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(res.errorMessage,/another workspace or task/);
 ctx.runtime.sessionParams={...session};
 const second=path.join(f.root,'second-task');
 await exec('git',['-C',f.primary,'worktree','add','-q','-b','pilot/second',second]);
 ctx.context.paperclipWorkspace={cwd:second,workspaceId:'ws-456'};
 res=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(res.errorMessage,/another workspace or task/);
});

test('implementation requires workspace ID and explicit authorization',async t=>{
 const {f,ctx,config,spawned}=await dynamicSetup(t,{mode:'implementation'});
 delete ctx.context.paperclipWorkspace.workspaceId;
 let result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(result.errorMessage,/workspace ID/);
 ctx.context.paperclipWorkspace.workspaceId='ws-123';
 config.enableImplementation=false;
 result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(result.errorMessage,/enableImplementation/);
 config.enableImplementation=true;
 result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.exitCode,0,JSON.stringify(result));
});

test('planning uses native agy plan mode; implementation is never accept-edits or yolo',async t=>{
 const {ctx}=await dynamicSetup(t);
 let args;
 ctx.onMeta=async m=>{args=m.commandArgs;};
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.exitCode,0,JSON.stringify(result));
 assert.ok(args.includes('--mode=plan'));
 assert.ok(!args.includes('--dangerously-skip-permissions'));
 ctx.config={...ctx.config,executionMode:'implementation',enableImplementation:true,approvedIssueIds:['task-123']};
 ctx.onMeta=async m=>{args=m.commandArgs;};
 const implement=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(implement.exitCode,0,JSON.stringify(implement));
 assert.ok(args.includes('--mode=default'));
 assert.ok(!args.includes('--mode=accept-edits'));
});

test('rejects remote execution targets even with valid checkout',async t=>{
 const {ctx,spawned}=await dynamicSetup(t);
 ctx.executionTarget={kind:'ssh'};
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(result.errorMessage,/Only local execution/);
 assert.equal(spawned.length,0);
});

test('environment test allows pending workspace during agent configuration, never claims execution ready',async t=>{
 const {config}=await dynamicSetup(t);
 const r=await testEnvironment({config:{...config,probeAuthentication:false}});
 assert.equal(r.status,'warn');
 assert.ok(r.checks.some(c=>c.code==='workspace'&&c.level==='warn'));
});

test('implementation refuses unapproved issue and never spawns agy', async t=>{
 const {ctx,spawned}=await dynamicSetup(t,{mode:'implementation'});
 ctx.config.approvedIssueIds=['some-other-issue'];
 const r=await executeWithHelpers(ctx, helpers, testDeps);
 assert.match(r.errorMessage,/no explicit issue or isolated project implementation authorization/);
 assert.equal(spawned.length,0);
});

test('unassigned heartbeat wake in Paperclip mode returns clean idle status without spawning agy', async t=>{
 const {f,config,ctx,spawned}=await dynamicSetup(t);
 // Emulate unassigned heartbeat / on-demand wake
 delete ctx.runtime.taskKey;
 delete ctx.context.taskKey;
 delete ctx.context.taskId;
 delete ctx.context.issueId;
 ctx.context.paperclipWorkspace={cwd:path.join(f.root,'agent-home'),source:'agent_home',strategy:'project_primary'};
 const result=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(result.exitCode,0,JSON.stringify(result));
 assert.equal(result.resultJson.status,'SUCCESS');
 assert.match(result.summary,/heartbeat completed/i);
 assert.equal(spawned.length,0);
});

test('task switch with forceFreshSession starts fresh session instead of failing', async t=>{
 const {f,ctx,spawned}=await dynamicSetup(t);
 const first=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(first.exitCode,0);
 assert.equal(first.sessionParams.taskKey,'task-123');
 // Now Paperclip assigns a new task with forceFreshSession
 ctx.runtime.taskKey='task-456';
 ctx.context.taskId='task-456';
 ctx.context.forceFreshSession=true;
 ctx.runtime.sessionParams=first.sessionParams;
 const second=await executeWithHelpers(ctx, helpers, testDeps);
 assert.equal(second.exitCode,0,JSON.stringify(second));
 assert.equal(second.sessionParams.taskKey,'task-456');
 assert.equal(spawned.length,2);
});

