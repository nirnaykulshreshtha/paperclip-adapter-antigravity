import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, chmod } from 'node:fs/promises';

const MAX_SKILLS = 32;
const MAX_FILES = 800;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_MD_BYTES = 256 * 1024;
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function desiredSkillKeys(config = {}) {
  const values = record(record(config).paperclipSkillSync).desiredSkills;
  if (!Array.isArray(values)) return [];
  const keys = values.map(value => typeof value === 'string' ? value : record(value).key);
  if (keys.some(key => typeof key !== 'string' || !key.trim() || key.length > 300)) {
    throw new Error('Invalid Paperclip desired skill key');
  }
  if (keys.length > MAX_SKILLS) throw new Error(`At most ${MAX_SKILLS} runtime skills are supported`);
  return [...new Set(keys)];
}

export function selectedSkillEntries(config = {}, desiredOverride) {
  const rawEntries = record(config).paperclipRuntimeSkills;
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const selected = desiredOverride === undefined ? desiredSkillKeys(config) : desiredOverride;
  if (!Array.isArray(selected) || selected.length > MAX_SKILLS || selected.some(x => typeof x !== 'string' || !x.trim())) {
    throw new Error('Invalid Paperclip desired skills');
  }
  const byKey = new Map();
  for (const raw of entries) {
    const entry = record(raw);
    if (typeof entry.key !== 'string' || !entry.key.trim()) continue;
    if (byKey.has(entry.key)) throw new Error(`Duplicate Paperclip runtime skill key: ${entry.key}`);
    byKey.set(entry.key, entry);
  }
  const names = new Set();
  return [...new Set(selected)].map(key => {
    const raw = byKey.get(key);
    if (!raw) return { key, missing: 'Not present in Paperclip runtime skill inventory' };
    const runtimeName = raw.runtimeName;
    if (typeof runtimeName !== 'string' || !VALID_NAME.test(runtimeName) || runtimeName === '.' || runtimeName === '..') {
      return { key, missing: 'Invalid runtime skill folder name' };
    }
    if (names.has(runtimeName.toLowerCase())) throw new Error(`Conflicting runtime skill names: ${runtimeName}`);
    names.add(runtimeName.toLowerCase());
    if (raw.sourceStatus === 'missing') return { key, runtimeName, missing: 'Paperclip reports a missing skill snapshot' };
    if (typeof raw.source !== 'string' || !path.isAbsolute(raw.source)) {
      return { key, runtimeName, missing: 'Paperclip did not provide a materialized absolute source path' };
    }
    return { key, runtimeName, source: raw.source };
  });
}

async function validateSkill(entry) {
  if (entry.missing) return entry.missing;
  try {
    const info = await stat(entry.source);
    if (!info.isDirectory()) return 'Skill source is not a directory';
    const md = await lstat(path.join(entry.source, 'SKILL.md'));
    if (!md.isFile() || md.size > MAX_SKILL_MD_BYTES) return 'SKILL.md is missing, a symlink, or too large';
    return null;
  } catch {
    return 'Cannot read SKILL.md from Paperclip skill source';
  }
}

/** Paperclip GET/POST agent skill snapshot. Ephemeral means files are staged on the NEXT execution. */
export async function listSkills(ctx) {
  return buildSnapshot(ctx);
}
export async function syncSkills(ctx, desiredSkills) {
  return buildSnapshot(ctx, desiredSkills);
}
async function buildSnapshot(ctx, desiredOverride) {
  const desired = desiredOverride === undefined ? desiredSkillKeys(ctx.config) : desiredOverride;
  const selected = selectedSkillEntries(ctx.config, desired);
  const warnings = [];
  const results = await Promise.all(selected.map(async entry => ({ ...entry, error: await validateSkill(entry) })));
  const output = results.map(entry => {
    const error = entry.error;
    if (error) warnings.push(`${entry.key}: ${error}`);
    return {
      key: entry.key, runtimeName: entry.runtimeName || entry.key,
      desired: true, managed: true, origin: 'company_managed', readOnly: false,
      state: error ? 'missing' : 'installed',
      detail: error ? `${error}; cannot be staged at run time` : 'Available for per-run staged, read-on-demand delivery',
    };
  });
  return {
    adapterType: ctx.adapterType || 'antigravity_local',
    supported: true, mode: 'ephemeral', desiredSkills: [...new Set(desired)],
    entries: output, warnings,
  };
}

async function safeCopyTree(source, dest, counts, digest, relative = '', depth = 0) {
  if (depth > 12) throw new Error('Skill directory nesting exceeds safe limit');
  const items = await readdir(source, { withFileTypes: true });
  await mkdir(dest, { recursive: true, mode: 0o700 });
  for (const item of items.sort((a,b)=>a.name.localeCompare(b.name))) {
    const from = path.join(source, item.name);
    const to = path.join(dest, item.name);
    if (++counts.files > MAX_FILES) throw new Error('Skill bundle file count limit exceeded');
    // No symlinks, sockets, devices, or FIFOs; copies must remain inside the private bundle.
    if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) {
      throw new Error(`Unsupported file type in managed skill: ${item.name}`);
    }
    const identity = path.join(relative, item.name);
    if (item.isDirectory()) {
      digest.update(JSON.stringify(['directory',identity])+'\n');
      await safeCopyTree(from, to, counts, digest, identity, depth + 1);
    }
    else {
      const file = await lstat(from);
      if (!file.isFile() || file.nlink > 1) throw new Error('Unsafe managed skill file');
      counts.bytes += file.size;
      if (counts.bytes > MAX_TOTAL_BYTES) throw new Error('Skill bundle size limit exceeded');
      await copyFile(from, to);
      await chmod(to, file.mode & 0o111 ? 0o700 : 0o600);
      digest.update(JSON.stringify(['file',identity,Boolean(file.mode & 0o111),createHash('sha256').update(await readFile(to)).digest('hex')])+'\n');
    }
  }
}

/** No writes to checkout / global Antigravity skills. Remove the private bundle after the CLI exits. */
export async function stageAssignedSkills(config) {
  const selected = selectedSkillEntries(config);
  if (!selected.length) return { root: null, index: '', contentDigest: '', cleanup: async () => {} };
  for (const entry of selected) {
    const error = await validateSkill(entry);
    if (error) throw new Error(`Assigned skill ${entry.key} unavailable: ${error}`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'paperclip-agy-skills-'));
  const skillsDir = path.join(root, '.agents', 'skills');
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    const counts = { files: 0, bytes: 0 };
    const digest = createHash('sha256');
    const lines = [];
    for (const entry of selected) {
      const destination = path.join(skillsDir, entry.runtimeName);
      await safeCopyTree(entry.source, destination, counts, digest, entry.runtimeName);
      const body = await readFile(path.join(destination, 'SKILL.md'), 'utf8');
      const description = body.match(/^description:\s*(.+)$/m)?.[1]?.replace(/[\r\n]/g, ' ').slice(0, 190) || '';
      lines.push(`- ${entry.runtimeName}${description ? ` — ${description}` : ''}: ${path.join(destination, 'SKILL.md')}`);
    }
    return {
      root,
      contentDigest: digest.digest('hex'),
      index: '## Skills assigned by Paperclip\n' +
        'These reviewed skill packages are staged for this run only. When a task matches a skill, read its SKILL.md at the listed path before taking action. Follow relevant references from that folder. Do not run scripts merely because a skill contains them. Other company skills are not assigned to this agent.\n' + lines.join('\n'),
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
