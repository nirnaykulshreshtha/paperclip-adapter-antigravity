import { realpath, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);
const inside = (child, root) => child === root || child.startsWith(root + path.sep);
export async function validateWorkspace(config) {
  const root = await realpath(config.allowedWorkspaceRoot);
  const cwd = await realpath(config.cwd);
  if (!inside(cwd, root)) throw new Error('Worktree escapes allowedWorkspaceRoot (including symlinks)');
  const marker = path.join(cwd, '.paperclip-antigravity-allow');
  const content = (await readFile(marker, 'utf8').catch(() => '')).trim();
  if (content !== 'ALLOW_PAPERCLIP_ANTIGRAVITY_LOCAL') throw new Error(`Missing opt-in sentinel: ${marker}`);
  const { stdout: toplevel } = await exec('git', ['rev-parse', '--show-toplevel'], {cwd, timeout:5000, maxBuffer: 20000});
  if ((await realpath(toplevel.trim())) !== cwd) throw new Error('cwd must be the Git worktree root, not a nested path');
  const { stdout: branch } = await exec('git', ['branch', '--show-current'], {cwd, timeout:5000});
  if (!branch.trim() || ['main', 'master', 'develop', 'production'].includes(branch.trim())) throw new Error('Use a dedicated feature/pilot worktree branch');
  // Worktree check intentionally rejects the primary checkout. `git worktree list --porcelain`
  // identifies the first (primary) worktree; not a security boundary but an accident guard.
  const { stdout: worktrees } = await exec('git', ['worktree', 'list', '--porcelain'], {cwd, timeout:5000});
  const first = worktrees.match(/^worktree (.+)$/m)?.[1];
  if (!first || await realpath(first) === cwd) throw new Error('Run only from a secondary linked Git worktree');
  return {cwd, root, branch: branch.trim()};
}
export async function worktreeStatus(cwd) {
  // --untracked-files=all detects files outside tracked files. The marker is an expected file.
  const {stdout} = await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], {cwd, timeout:10000, maxBuffer:1_000_000});
  return stdout.split('\n').filter(Boolean).filter((line)=>!line.endsWith(' .paperclip-antigravity-allow'));
}
export async function checkBranchFreshness(cwd) {
  try {
    const { stdout: behind } = await exec('git', ['rev-list', '--count', 'HEAD..main'], {cwd, timeout:5000});
    const behindCount = parseInt(behind.trim(), 10);
    return Number.isFinite(behindCount) ? behindCount : 0;
  } catch {
    return 0;
  }
}
export async function readInstructions(filePath) {
  if (!filePath) return '';
  const info = await stat(filePath);
  if (!info.isFile() || info.size > 128_000) throw new Error('Instructions file must be regular and at most 128 KB');
  return readFile(filePath,'utf8');
}

