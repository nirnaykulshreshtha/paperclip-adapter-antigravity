import { realpath, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);
const contained = (child, root) => child === root || child.startsWith(root + path.sep);
const str = v => typeof v === 'string' ? v.trim() : '';

async function git(cwd, ...args) {
  const { stdout } = await exec('git', args, { cwd, timeout: 10000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}
async function commonGitDir(cwd) {
  const raw = await git(cwd, 'rev-parse', '--git-common-dir');
  return realpath(path.resolve(cwd, raw));
}

/**
 * A Paperclip context is a routing hint, not an authorization credential.
 * Resolve and verify every path against an explicitly trusted repository,
 * registered Git worktree, and operator-authorized worktree parent.
 */
export async function resolveAssignedWorkspace(ctx, cfg) {
  if (cfg.workspaceMode !== 'paperclip') throw new Error('Assigned-workspace resolver requires workspaceMode=paperclip');
  const supplied = ctx?.context?.paperclipWorkspace;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new Error('Paperclip did not supply an execution workspace; assign an isolated issue checkout before running');
  }
  const assignedCwd = str(supplied.cwd);
  if (!path.isAbsolute(assignedCwd)) throw new Error('Paperclip execution workspace cwd must be absolute');
  const taskKey = str(ctx?.runtime?.taskKey) || str(ctx?.context?.taskKey) || str(ctx?.context?.taskId) || str(ctx?.context?.issueId);
  if (!taskKey) throw new Error('Issue/workspace run requires a stable Paperclip task identifier');
  if (!path.isAbsolute(cfg.repositoryRoot) || !path.isAbsolute(cfg.allowedWorkspaceRoot)) {
    throw new Error('repositoryRoot and allowedWorkspaceRoot must be absolute');
  }
  const [cwd, primary, allowedRoot] = await Promise.all([
    realpath(assignedCwd), realpath(cfg.repositoryRoot), realpath(cfg.allowedWorkspaceRoot),
  ]);
  // Explicitly prohibit main checkout even in planning mode. Never auto-create worktrees.
  if (cwd === primary) throw new Error('Paperclip selected the primary checkout; choose an isolated issue worktree');
  if (!contained(cwd, allowedRoot) || cwd === allowedRoot) {
    throw new Error('Assigned workspace is outside the authorized worktree parent');
  }
  if (contained(allowedRoot, cwd)) throw new Error('Invalid workspace containment');
  const approval = (await readFile(path.join(allowedRoot, '.paperclip-antigravity-allow'), 'utf8').catch(() => '')).trim();
  if (approval !== 'ALLOW_PAPERCLIP_ANTIGRAVITY_LOCAL') {
    throw new Error('Authorized worktree parent is missing .paperclip-antigravity-allow marker');
  }
  const [primaryTop, assignedTop, primaryCommon, assignedCommon, worktrees, branch] = await Promise.all([
    git(primary, 'rev-parse', '--show-toplevel'),
    git(cwd, 'rev-parse', '--show-toplevel'),
    commonGitDir(primary), commonGitDir(cwd),
    git(primary, 'worktree', 'list', '--porcelain'),
    git(cwd, 'branch', '--show-current'),
  ]);
  if (await realpath(primaryTop) !== primary || await realpath(assignedTop) !== cwd) {
    throw new Error('Assigned workspace or repositoryRoot is not a Git checkout root');
  }
  if (primaryCommon !== assignedCommon) {
    throw new Error('Assigned worktree is from a different Git repository');
  }
  const entries = worktrees.split(/(?=^worktree )/m).map(s => s.match(/^worktree (.+)$/m)?.[1]).filter(Boolean);
  const canonicalEntries = await Promise.all(entries.map(v => realpath(v).catch(() => null)));
  if (canonicalEntries[0] !== primary || !canonicalEntries.includes(cwd) || cwd === canonicalEntries[0]) {
    throw new Error('Assigned workspace is not a registered secondary Git worktree');
  }
  if (!branch || ['main','master','develop','production'].includes(branch)) {
    throw new Error('Assigned issue worktree must use a dedicated, non-protected branch');
  }
  const workspaceId = str(supplied.workspaceId) || str(supplied.executionWorkspaceId);
  if (cfg.executionMode === 'implementation' && !workspaceId) {
    throw new Error('Implementation needs a Paperclip execution workspace ID');
  }
  return { cwd, root: allowedRoot, branch, workspaceId, taskKey, projectId: str(supplied.projectId), source: str(supplied.source), strategy: str(supplied.strategy) };
}
