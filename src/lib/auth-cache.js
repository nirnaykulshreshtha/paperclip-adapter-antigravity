import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolvePaperclipInstanceRootForAdapter } from '@paperclipai/adapter-utils/server-utils';
import { withDirectoryMergeLock } from '@paperclipai/adapter-utils/workspace-restore-merge';

const CACHE_DIR_NAME = 'antigravity-auth-cache';
const CACHE_ENTRY_FILE = 'auth.json';
const PRIVATE_DIR_MODE = 0o700;

export const ANTIGRAVITY_AUTH_CACHE_OFF_SWITCH_ENV = 'PAPERCLIP_ANTIGRAVITY_AUTH_CACHE';
const FALSY_ENV_RE = /^(0|false|no|off)$/i;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function isAntigravityAuthCacheEnabled(env = process.env) {
  const raw = env[ANTIGRAVITY_AUTH_CACHE_OFF_SWITCH_ENV];
  if (typeof raw !== 'string') return true;
  return !FALSY_ENV_RE.test(raw.trim());
}

export function toSafePathSegment(value, label) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    throw new Error(`antigravity auth cache: ${label} is empty`);
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`antigravity auth cache: ${label} is a relative path segment`);
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error(`antigravity auth cache: ${label} contains a path separator`);
  }
  if (path.basename(trimmed) !== trimmed) {
    throw new Error(`antigravity auth cache: ${label} is not a single path segment`);
  }
  return trimmed;
}

export function toCacheKey(accountId) {
  return toSafePathSegment(accountId, 'accountId');
}

/**
 * Resolves the company-scoped cache root under Paperclip instance isolation.
 */
export function resolveAntigravityAuthCacheDir(env = process.env, companyId) {
  const safeCompanyId = toSafePathSegment(companyId, 'companyId');
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env?.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env?.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.join(instanceRoot, 'companies', safeCompanyId, CACHE_DIR_NAME);
}

/**
 * Resolves the entry path for one identity: <cacheRoot>/<safeAccountId>/auth.json.
 */
export function resolveAntigravityAuthCacheEntryPath(env = process.env, accountId, companyId) {
  const cacheRoot = resolveAntigravityAuthCacheDir(env, companyId);
  const safeKey = toCacheKey(accountId);
  const entry = path.join(cacheRoot, safeKey, CACHE_ENTRY_FILE);
  const relative = path.relative(cacheRoot, entry);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('antigravity auth cache: entry path escapes cache root');
  }
  return entry;
}

/**
 * Ensures the company-scoped cache root and entry directory exist private (0700).
 */
export async function ensureAntigravityAuthCacheEntryDir(env = process.env, accountId, companyId) {
  const entryPath = resolveAntigravityAuthCacheEntryPath(env, accountId, companyId);
  const entryDir = path.dirname(entryPath);
  await mkdir(entryDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  return entryPath;
}

/**
 * Writes an auth.json credential payload atomically with 0600 mode under directory merge lock.
 */
export async function writeAntigravityAuthCacheEntry({
  authBytes,
  cacheEntryPath,
  env = process.env,
}) {
  const entryDir = path.dirname(cacheEntryPath);
  await mkdir(entryDir, { recursive: true, mode: PRIVATE_DIR_MODE });

  return withDirectoryMergeLock(entryDir, async () => {
    const tmp = path.join(entryDir, `.${path.basename(cacheEntryPath)}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = await open(tmp, 'wx', 0o600);
      await fd.writeFile(authBytes);
      await fd.sync();
      await fd.close();
      fd = null;
      await rename(tmp, cacheEntryPath);
      return 'written';
    } finally {
      if (fd) await fd.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
    }
  }, { env });
}

/**
 * Reads cache credential payload if present and valid.
 */
export async function readAntigravityAuthCacheEntry(cacheEntryPath) {
  try {
    const buf = await readFile(cacheEntryPath);
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

export const USE_SOURCE_EXIT = 10;
export const KEEP_DESTINATION_EXIT = 20;
export const IMPLAUSIBLE_LAST_REFRESH_EXIT = 22;

export function resolveAntigravityHostAuthPath(env = process.env) {
  if (typeof env.PAPERCLIP_ANTIGRAVITY_HOST_AUTH_PATH === 'string' && env.PAPERCLIP_ANTIGRAVITY_HOST_AUTH_PATH.trim()) {
    return path.resolve(env.PAPERCLIP_ANTIGRAVITY_HOST_AUTH_PATH.trim());
  }
  if (typeof env.ANTIGRAVITY_AUTH_PATH === 'string' && env.ANTIGRAVITY_AUTH_PATH.trim()) {
    return path.resolve(env.ANTIGRAVITY_AUTH_PATH.trim());
  }
  const home = env.HOME || os.homedir();
  return path.join(home, '.gemini', 'antigravity-cli', 'auth.json');
}

export function readSubscriptionAccountId(authBytesOrObj) {
  try {
    const obj = typeof authBytesOrObj === 'string' || Buffer.isBuffer(authBytesOrObj)
      ? JSON.parse(authBytesOrObj.toString('utf8'))
      : authBytesOrObj;
    if (!obj || typeof obj !== 'object') return null;
    const id = obj.email || obj.accountId || obj.account_id || obj.id;
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
  } catch {
    return null;
  }
}

function parseAuthTimestamp(authObj) {
  if (!authObj || typeof authObj !== 'object') return null;
  const ts = authObj.lastRefreshedAt ?? authObj.last_refresh ?? authObj.updated_at ?? authObj.timestamp ?? authObj.token?.expiry ?? authObj.expiry;
  if (ts) {
    const parsed = new Date(ts).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Decides whether to replace host credential destination with sandbox source:
 * - USE_SOURCE_EXIT (10): install source over destination
 * - KEEP_DESTINATION_EXIT (20): keep destination
 * - IMPLAUSIBLE_LAST_REFRESH_EXIT (22): keep destination (source last refresh implausibly in future)
 */
export function decideAntigravityAuthMerge(sourceObj, destinationObj, options = {}) {
  const now = options.now ?? Date.now();
  const maxSkewMs = options.maxSkewMs ?? 5 * 60 * 1000;

  if (!sourceObj || typeof sourceObj !== 'object') return KEEP_DESTINATION_EXIT;

  const sourceTs = parseAuthTimestamp(sourceObj);
  if (sourceTs !== null && sourceTs > now + maxSkewMs) {
    return IMPLAUSIBLE_LAST_REFRESH_EXIT;
  }

  if (!destinationObj || typeof destinationObj !== 'object') {
    return USE_SOURCE_EXIT;
  }

  const sourceId = readSubscriptionAccountId(sourceObj);
  const destId = readSubscriptionAccountId(destinationObj);

  if (sourceId && destId && sourceId !== destId) {
    return KEEP_DESTINATION_EXIT;
  }

  const destTs = parseAuthTimestamp(destinationObj);
  if (sourceTs !== null && destTs !== null) {
    return sourceTs > destTs ? USE_SOURCE_EXIT : KEEP_DESTINATION_EXIT;
  }
  if (sourceTs !== null && destTs === null) {
    return USE_SOURCE_EXIT;
  }

  return KEEP_DESTINATION_EXIT;
}

/**
 * Guards, locks, and atomically installs a strictly-newer sandbox Antigravity auth.json
 * onto the shared host credential at teardown.
 */
export async function copyBackAntigravityAuth(input) {
  const { readSandboxAuth, hostAuthPath, log = async () => {}, resolveCacheEntryPath, env = process.env } = input;

  let sandboxAuthBytes;
  try {
    sandboxAuthBytes = await readSandboxAuth();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await log('[paperclip] Antigravity auth copy-back: no sandbox credential to copy back (absent auth.json); host credential kept.');
      return 'kept-host';
    }
    throw error;
  }

  const hostDir = path.dirname(hostAuthPath);
  await mkdir(hostDir, { recursive: true, mode: PRIVATE_DIR_MODE });

  const hostOutcome = await withDirectoryMergeLock(hostDir, async () => {
    const stagedTempPath = path.join(hostDir, `.auth.json.copyback-${process.pid}-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = await open(stagedTempPath, 'wx', 0o600);
      await fd.writeFile(sandboxAuthBytes);
      await fd.sync();
      await fd.close();
      fd = null;

      let sourceObj;
      try {
        sourceObj = JSON.parse(sandboxAuthBytes.toString('utf8'));
      } catch {
        await log('[paperclip] Antigravity auth copy-back: sandbox credential is not valid JSON; host credential kept.');
        return 'kept-host';
      }

      let destObj = null;
      try {
        const destBytes = await readFile(hostAuthPath);
        destObj = JSON.parse(destBytes.toString('utf8'));
      } catch {}

      const decision = decideAntigravityAuthMerge(sourceObj, destObj);
      if (decision === USE_SOURCE_EXIT) {
        await rename(stagedTempPath, hostAuthPath);
        await log('[paperclip] Antigravity auth copy-back: sandbox credential is strictly newer for the same subscription identity; installed to the host at mode 0600.');
        return 'copied';
      }
      if (decision === IMPLAUSIBLE_LAST_REFRESH_EXIT) {
        await log(`[paperclip] Antigravity auth copy-back: WARNING host credential kept (decision exit ${IMPLAUSIBLE_LAST_REFRESH_EXIT}) — sandbox last refresh sat further ahead than plausible clock skew.`);
        return 'kept-host';
      }
      await log('[paperclip] Antigravity auth copy-back: host credential kept (sandbox copy is not strictly newer).');
      return 'kept-host';
    } finally {
      if (fd) await fd.close().catch(() => {});
      await rm(stagedTempPath, { force: true }).catch(() => {});
    }
  }, { env });

  if (resolveCacheEntryPath && isAntigravityAuthCacheEnabled(env)) {
    try {
      const sandboxAccountId = readSubscriptionAccountId(sandboxAuthBytes);
      if (sandboxAccountId) {
        const cacheEntryPath = await resolveCacheEntryPath(sandboxAccountId);
        await writeAntigravityAuthCacheEntry({
          authBytes: sandboxAuthBytes,
          cacheEntryPath,
          env,
        });
      }
    } catch (error) {
      const code = error?.code ?? 'unknown';
      await Promise.resolve(log(`[paperclip] Antigravity auth cache: additive cache write failed (${code}); host copy-back result kept.`)).catch(() => {});
    }
  }

  return hostOutcome;
}

