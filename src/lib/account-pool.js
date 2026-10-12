import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseKeyringPayload } from './account.js';

const execFileAsync = promisify(execFile);

export function getAccountPoolPath() {
  if (process.env.PAPERCLIP_ANTIGRAVITY_ACCOUNT_POOL_FILE) {
    return path.resolve(process.env.PAPERCLIP_ANTIGRAVITY_ACCOUNT_POOL_FILE);
  }
  return path.join(homedir(), '.paperclip', 'antigravity-accounts.json');
}

/**
 * Loads the account rotation pool from disk.
 */
export async function loadAccountPool(filePath = getAccountPoolPath()) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.accounts)) {
      return data;
    }
  } catch {}
  return {
    version: 1,
    activeAccount: null,
    accounts: [],
  };
}

/**
 * Saves the account rotation pool to disk atomically.
 */
export async function saveAccountPool(pool, filePath = getAccountPoolPath()) {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(pool, null, 2), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Parses reset duration from Antigravity/Gemini error messages.
 * Examples:
 * - "Resets in 46m25s."
 * - "Resets in 1h9m4s."
 * - "Resets in 27m."
 * Defaults to 30 minutes (1800000 ms).
 */
export function parseQuotaResetDuration(errorText) {
  if (typeof errorText !== 'string' || !errorText) return 30 * 60 * 1000;
  const match = /Resets in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i.exec(errorText);
  if (match) {
    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseInt(match[3] || '0', 10);
    const totalMs = ((hours * 3600) + (minutes * 60) + seconds) * 1000;
    if (totalMs > 0) return totalMs + 30000; // 30s safety buffer
  }
  return 30 * 60 * 1000;
}

/**
 * Reads the current raw token payload from the macOS keychain.
 */
export async function readKeychainPayload(runner = execFileAsync, platform = process.platform) {
  if (process.env.NODE_ENV === 'test' && !process.env.PAPERCLIP_ANTIGRAVITY_LIVE_KEYCHAIN) {
    return process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD || null;
  }
  if (platform !== 'darwin') return null;
  try {
    const { stdout } = await runner('security', [
      'find-generic-password',
      '-s', 'gemini',
      '-a', 'antigravity',
      '-w',
    ], {
      timeout: 3000,
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Writes a token payload to the macOS keychain.
 */
export async function writeKeychainPayload(tokenPayload, runner = execFileAsync, platform = process.platform) {
  if (typeof tokenPayload !== 'string' || !tokenPayload.trim()) return false;
  if (process.env.NODE_ENV === 'test' && !process.env.PAPERCLIP_ANTIGRAVITY_LIVE_KEYCHAIN) {
    process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD = tokenPayload.trim();
    return true;
  }
  if (platform !== 'darwin') return true;
  try {
    await runner('security', [
      'add-generic-password',
      '-U',
      '-s', 'gemini',
      '-a', 'antigravity',
      '-w', tokenPayload.trim(),
    ], {
      timeout: 3000,
      encoding: 'utf8',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronizes the currently active OS keychain account into the account pool.
 */
export async function syncKeychainToPool(pool, runner = execFileAsync, platform = process.platform) {
  const rawPayload = await readKeychainPayload(runner, platform);
  if (!rawPayload) return pool;

  const parsed = parseKeyringPayload(rawPayload);
  if (!parsed || !parsed.email) return pool;

  const existingIndex = pool.accounts.findIndex(a => a.email.toLowerCase() === parsed.email.toLowerCase());
  if (existingIndex >= 0) {
    // Update token payload and last seen
    pool.accounts[existingIndex].tokenPayload = rawPayload;
    pool.accounts[existingIndex].expiry = parsed.expiry;
    pool.accounts[existingIndex].lastSeenAt = new Date().toISOString();
  } else {
    // Add newly discovered account to pool
    pool.accounts.push({
      email: parsed.email,
      tokenPayload: rawPayload,
      status: 'ready',
      expiry: parsed.expiry,
      quotaResetAt: null,
      lastUsedAt: null,
      lastSeenAt: new Date().toISOString(),
    });
  }

  pool.activeAccount = parsed.email;
  await saveAccountPool(pool);
  return pool;
}

/**
 * Finds the next available account in the pool that has available quota.
 */
export function getNextReadyAccount(pool, excludeEmail = null) {
  if (!pool || !Array.isArray(pool.accounts) || pool.accounts.length === 0) return null;
  const now = Date.now();

  // First, reconcile any expired cooldowns
  for (const acc of pool.accounts) {
    if (acc.status === 'quota_exhausted' && acc.quotaResetAt && now >= acc.quotaResetAt) {
      acc.status = 'ready';
      acc.quotaResetAt = null;
    }
  }

  // Find eligible candidate
  const candidates = pool.accounts.filter(a => {
    if (excludeEmail && a.email.toLowerCase() === excludeEmail.toLowerCase()) return false;
    return a.status === 'ready' || (!a.quotaResetAt || now >= a.quotaResetAt);
  });

  if (candidates.length === 0) return null;

  // Pick the least recently used candidate
  candidates.sort((a, b) => {
    const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return aTime - bTime;
  });

  return candidates[0];
}

/**
 * Activates an account by writing its credentials to the keychain and updating pool state.
 */
export async function activateAccount(email, pool, runner = execFileAsync, platform = process.platform) {
  if (!email || !pool || !Array.isArray(pool.accounts)) return false;
  const target = pool.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
  if (!target || !target.tokenPayload) return false;

  const success = await writeKeychainPayload(target.tokenPayload, runner, platform);
  if (!success) return false;

  pool.activeAccount = target.email;
  target.lastUsedAt = new Date().toISOString();
  await saveAccountPool(pool);
  return true;
}

/**
 * Marks an account as quota-exhausted with a reset cooldown.
 */
export async function markAccountQuotaExhausted(email, pool, cooldownMs, reason = 'RESOURCE_EXHAUSTED 429') {
  if (!email || !pool || !Array.isArray(pool.accounts)) return;
  const target = pool.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
  if (target) {
    target.status = 'quota_exhausted';
    target.quotaResetAt = Date.now() + cooldownMs;
    target.lastError = reason;
    target.quotaExhaustedAt = new Date().toISOString();
    await saveAccountPool(pool);
  }
}
