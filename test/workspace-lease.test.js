import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {acquireWorkspaceLease,workspaceOwnerPath} from '../src/lib/workspace-lease.js';
async function setup(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'agy-lease-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cwd=path.join(root,'checkout');await mkdir(cwd);
 return {cwd,env:{PAPERCLIP_HOME:path.join(root,'state')}};
}
test('serializes symlink aliases of one workspace and releases after a stopped provider',async t=>{
 const {cwd,env}=await setup(t);const alias=cwd+'-alias';await symlink(cwd,alias);
 const first=await acquireWorkspaceLease(cwd,{env,runId:'first'});
 let entered=false;const second=acquireWorkspaceLease(alias,{env,runId:'second'}).then(l=>{entered=true;return l;});
 await new Promise(r=>setTimeout(r,30));assert.equal(entered,false);
 await first.release(true);const next=await second;await next.release(true);
 await assert.rejects(access(workspaceOwnerPath(await realpath(cwd),env)),/ENOENT/);
});
test('retains unknown dispatch outcomes and refuses another writer',async t=>{
 const {cwd,env}=await setup(t);const first=await acquireWorkspaceLease(cwd,{env});
 await first.markDispatch();await first.release(false);
 await assert.rejects(acquireWorkspaceLease(cwd,{env}),e=>e.code==='workspace_busy');
});
test('a surviving provider blocks reuse even after controller death',async t=>{
 const {cwd,env}=await setup(t);const file=workspaceOwnerPath(await realpath(cwd),env);
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 await writeFile(file,JSON.stringify({version:1,nonce:'old',controllerPid:99999999,providerMayHaveStarted:true,providerPid:process.pid}),{mode:0o600});
 await assert.rejects(acquireWorkspaceLease(cwd,{env}),e=>e.code==='workspace_busy');
});
test('cancellation while queued never acquires an execution lease',async t=>{
 const {cwd,env}=await setup(t);const first=await acquireWorkspaceLease(cwd,{env});
 const abort=new AbortController();const second=acquireWorkspaceLease(cwd,{env,signal:abort.signal});
 abort.abort();await first.release(true);await assert.rejects(second,/Canceled/);
});

test('retains a real surviving process group and reclaims only after it exits',{skip:process.platform==='win32'},async t=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');
 const {cwd,env}=await setup(t);
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 await once(child,'spawn');
 const lease=await acquireWorkspaceLease(cwd,{env});await lease.markDispatch();await lease.markSpawn(child.pid,child.pid);
 await assert.rejects(lease.assertStopped(),e=>e.code==='workspace_busy');await lease.release(false);
 await assert.rejects(acquireWorkspaceLease(cwd,{env}),e=>e.code==='workspace_busy');
 const exited=once(child,'exit');process.kill(-child.pid,'SIGKILL');await exited;
 const next=await acquireWorkspaceLease(cwd,{env});await next.release(true);
});
