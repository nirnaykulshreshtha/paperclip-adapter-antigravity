import { mkdir, lstat, readFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolvePaperclipInstanceRootForAdapter } from '@paperclipai/adapter-utils/server-utils';
import { withDirectoryMergeLock, WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from '@paperclipai/adapter-utils/workspace-restore-merge';

export class WorkspaceBusyError extends Error {
  constructor(message) { super(message); this.code = 'workspace_busy'; }
}
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid === 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};
export function workspaceOwnerPath(cwd, env = process.env) {
  const root = resolvePaperclipInstanceRootForAdapter({ env, homeDir: env.PAPERCLIP_HOME, instanceId: env.PAPERCLIP_INSTANCE_ID });
  return path.join(root, 'antigravity-workspace-owners', createHash('sha256').update(cwd).digest('hex') + '.json');
}
async function readOwner(file) {
  const st = await lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (!st) return null;
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 4096 || (process.getuid && st.uid !== process.getuid())) throw new WorkspaceBusyError('Workspace ownership receipt is unsafe; inspect it before continuing');
  try {
    const owner=JSON.parse(await readFile(file, 'utf8'));
    if (owner?.version !== 1 || typeof owner.nonce !== 'string' || typeof owner.providerMayHaveStarted !== 'boolean' || !Number.isSafeInteger(owner.controllerPid) || owner.controllerPid <= 0 || (owner.providerPid != null && (!Number.isSafeInteger(owner.providerPid) || owner.providerPid <= 0)) || (owner.providerProcessGroupId != null && (!Number.isSafeInteger(owner.providerProcessGroupId) || owner.providerProcessGroupId <= 0))) throw new Error('Invalid owner');
    return owner;
  }
  catch { throw new WorkspaceBusyError('Workspace ownership receipt is unreadable; reconcile it before continuing'); }
}
async function writeOwner(file, data) {
  const temp = file + '.' + randomUUID();
  let fd;
  try {
    fd=await open(temp,'wx',0o600);
    await fd.writeFile(JSON.stringify(data)); await fd.sync(); await fd.close(); fd=null;
    await rename(temp,file);
  } finally {
    if(fd) await fd.close().catch(()=>{});
    await rm(temp,{force:true});
  }
}

/** Use Paperclip's cross-process lock plus a durable child-PID receipt. A dead
 * controller alone is not permission to overwrite a surviving CLI's work. */
export async function acquireWorkspaceLease(cwd, { env = process.env, signal, runId } = {}) {
  let enter, reject, leave;
  const ready = new Promise((yes, no) => { enter = yes; reject = no; });
  const gate = new Promise(resolve => { leave = resolve; });
  let removeOwner = false;
  const held = withDirectoryMergeLock(cwd, async canonical => {
    if (signal?.aborted) throw new Error('Canceled while waiting for the workspace lease');
    const file = workspaceOwnerPath(canonical, env);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const dir = await lstat(path.dirname(file));
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.getuid && dir.uid !== process.getuid()) || (dir.mode & 0o077)) throw new WorkspaceBusyError('Workspace ownership directory must be private and owned by the worker');
    const old = await readOwner(file);
    if (old?.providerMayHaveStarted && (!old.providerPid || alive(old.providerPid) || (old.providerProcessGroupId && alive(-old.providerProcessGroupId)))) throw new WorkspaceBusyError('A previous CLI may still own this workspace; verify it stopped before recovery');
    const owner = { version: 1, nonce: randomUUID(), controllerPid: process.pid, runId: typeof runId === 'string' ? runId.slice(0,128) : null, providerMayHaveStarted: false, providerPid: null, providerProcessGroupId: null };
    await writeOwner(file, owner);
    enter({
      async markDispatch() { owner.providerMayHaveStarted = true; await writeOwner(file, owner); },
      async markSpawn(pid, groupId) { owner.providerPid = pid; owner.providerProcessGroupId = groupId ?? null; await writeOwner(file, owner); },
      async assertStopped() { if ((owner.providerPid && alive(owner.providerPid)) || (owner.providerProcessGroupId && alive(-owner.providerProcessGroupId))) throw new WorkspaceBusyError('CLI process group still owns the workspace after exit; reconcile before continuing'); },
      async release(providerStopped) { removeOwner = providerStopped && !(owner.providerPid && alive(owner.providerPid)) && !(owner.providerProcessGroupId && alive(-owner.providerProcessGroupId)); leave(); await held; },
    });
    try { await gate; }
    finally {
      if (removeOwner && (await readOwner(file))?.nonce === owner.nonce) await rm(file);
    }
  }, env);
  held.catch(error => {
    if (error.code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) reject(new WorkspaceBusyError('Workspace is busy with another writer; no model turn was started'));
    else reject(error);
  });
  return ready;
}
