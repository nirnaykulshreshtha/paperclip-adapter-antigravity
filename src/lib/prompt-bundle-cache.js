import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { ensurePaperclipSkillSymlink, resolvePaperclipInstanceRootForAdapter } from '@paperclipai/adapter-utils/server-utils';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveManagedAntigravityPromptCacheRoot(env = process.env, companyId) {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env?.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env?.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, 'companies', companyId || 'default', 'antigravity-prompt-cache');
}

/**
 * Builds a deterministic bundle key for instructions and assigned skills.
 */
export function buildPromptBundleKey(input = {}) {
  const hash = createHash('sha256');
  hash.update('paperclip-antigravity-prompt-bundle:v1\n');

  if (input.instructionsContents) {
    hash.update('instructions\n');
    hash.update(input.instructionsContents);
    hash.update('\n');
  } else {
    hash.update('instructions:none\n');
  }

  const sortedSkills = Array.isArray(input.skills)
    ? [...input.skills].sort((a, b) => String(a.runtimeName || '').localeCompare(String(b.runtimeName || '')))
    : [];

  for (const skill of sortedSkills) {
    hash.update(`skill:${skill.key || ''}:${skill.runtimeName || ''}\n`);
    if (skill.source) hash.update(`source:${skill.source}\n`);
  }

  return hash.digest('hex');
}

/**
 * Ensures an instructions file exists and is readable.
 */
async function ensureReadableFile(targetPath, contents) {
  try {
    await fs.access(targetPath, fsConstants.R_OK);
    return;
  } catch {}
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, targetPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * Prepares a cached prompt bundle directory containing materialized instructions.
 */
export async function preparePromptBundle(input = {}) {
  const { companyId = 'default', skills = [], instructionsContents = '', env = process.env, onLog } = input;
  const bundleKey = buildPromptBundleKey({ skills, instructionsContents });
  const rootDir = path.join(resolveManagedAntigravityPromptCacheRoot(env, companyId), bundleKey);
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });

  const skillsHome = path.join(rootDir, '.agents', 'skills');
  await fs.mkdir(skillsHome, { recursive: true, mode: 0o700 });

  const sortedSkills = Array.isArray(skills)
    ? [...skills].sort((a, b) => String(a.runtimeName || '').localeCompare(String(b.runtimeName || '')))
    : [];

  for (const entry of sortedSkills) {
    if (!entry.source || !entry.runtimeName) continue;
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      await ensurePaperclipSkillSymlink(entry.source, target);
    } catch (err) {
      if (typeof onLog === 'function') {
        await onLog('stderr', `[paperclip] Failed to materialize Antigravity skill "${entry.key || entry.runtimeName}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  let instructionsFilePath = null;
  if (instructionsContents) {
    instructionsFilePath = path.join(rootDir, 'instructions.md');
    await ensureReadableFile(instructionsFilePath, instructionsContents);
  }

  return {
    bundleKey,
    rootDir,
    addDir: rootDir,
    skillsHome,
    instructionsFilePath,
  };
}
