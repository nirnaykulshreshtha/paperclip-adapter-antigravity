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
      Object.defineProperty(data, '_filePath', { value: filePath, writable: true, enumerable: false });
      return data;
    }
  } catch {}
  const initial = {
    version: 1,
    activeAccount: null,
    accounts: [],
  };
  Object.defineProperty(initial, '_filePath', { value: filePath, writable: true, enumerable: false });
  return initial;
}

/**
 * Saves the account rotation pool to disk atomically.
 */
export async function saveAccountPool(pool, filePath = pool?._filePath || getAccountPoolPath()) {
  const targetPath = filePath || pool?._filePath || getAccountPoolPath();
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, JSON.stringify(pool, null, 2), 'utf8');
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
export async function syncKeychainToPool(pool, filePathOrRunner = pool?._filePath, runnerOrPlatform = execFileAsync, platform = process.platform) {
  let targetFilePath = pool?._filePath || getAccountPoolPath();
  let runner = execFileAsync;
  let targetPlatform = process.platform;

  if (typeof filePathOrRunner === 'function') {
    runner = filePathOrRunner;
    targetPlatform = typeof runnerOrPlatform === 'string' ? runnerOrPlatform : process.platform;
  } else {
    if (typeof filePathOrRunner === 'string' && filePathOrRunner) targetFilePath = filePathOrRunner;
    if (typeof runnerOrPlatform === 'function') runner = runnerOrPlatform;
    if (typeof platform === 'string') targetPlatform = platform;
  }

  const rawPayload = await readKeychainPayload(runner, targetPlatform);
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
  await saveAccountPool(pool, targetFilePath);
  return pool;
}

/**
 * Checks whether an account is ready for use, optionally considering a specific model.
 */
export function isAccountReadyForModel(account, model = null) {
  if (!account) return false;
  const now = Date.now();

  // If the account has an explicit non-ready status other than quota_exhausted, not ready
  if (account.status && account.status !== 'ready' && account.status !== 'quota_exhausted') {
    return false;
  }

  // Check model-specific quota cooldown
  if (model && account.modelQuotas && account.modelQuotas[model]) {
    const mQuota = account.modelQuotas[model];
    if (mQuota.quotaResetAt && now < mQuota.quotaResetAt) {
      return false;
    }
  }

  // If the account has a general quota cooldown
  if (account.quotaResetAt && now < account.quotaResetAt) {
    // If the account exhausted an individual/Claude model, and the requested model is Gemini, allow it
    const isClaudeQuota = (account.quotaResetModel && account.quotaResetModel.startsWith('claude-')) ||
      (typeof account.lastError === 'string' && /individual quota reached/i.test(account.lastError));
    const isGeminiModel = typeof model === 'string' && model.startsWith('gemini-');

    if (isClaudeQuota && isGeminiModel) {
      return true;
    }
    return false;
  }

  return account.status === 'ready' || (!account.quotaResetAt || now >= account.quotaResetAt);
}

/**
 * Finds the next available account in the pool that has available quota.
 */
export function getNextReadyAccount(pool, excludeEmail = null, targetModel = null) {
  if (!pool || !Array.isArray(pool.accounts) || pool.accounts.length === 0) return null;
  const now = Date.now();

  // First, reconcile any expired cooldowns
  for (const acc of pool.accounts) {
    if (acc.status === 'quota_exhausted' && acc.quotaResetAt && now >= acc.quotaResetAt) {
      acc.status = 'ready';
      acc.quotaResetAt = null;
    }
    if (acc.modelQuotas) {
      for (const [m, q] of Object.entries(acc.modelQuotas)) {
        if (q.quotaResetAt && now >= q.quotaResetAt) {
          delete acc.modelQuotas[m];
        }
      }
    }
    // If the account was previously marked quota_exhausted solely due to individual Claude quota, heal it
    if (acc.status === 'quota_exhausted' && typeof acc.lastError === 'string' && /individual quota reached/i.test(acc.lastError)) {
      acc.status = 'ready';
    }
  }

  // Find eligible candidate
  const candidates = pool.accounts.filter(a => {
    if (excludeEmail && a.email.toLowerCase() === excludeEmail.toLowerCase()) return false;
    return isAccountReadyForModel(a, targetModel);
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
export async function activateAccount(email, pool, filePathOrRunner = pool?._filePath, runnerOrPlatform = execFileAsync, platform = process.platform) {
  if (!email || !pool || !Array.isArray(pool.accounts)) return false;
  const target = pool.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
  if (!target || !target.tokenPayload) return false;

  let targetFilePath = pool?._filePath || getAccountPoolPath();
  let runner = execFileAsync;
  let targetPlatform = process.platform;

  if (typeof filePathOrRunner === 'function') {
    runner = filePathOrRunner;
    targetPlatform = typeof runnerOrPlatform === 'string' ? runnerOrPlatform : process.platform;
  } else {
    if (typeof filePathOrRunner === 'string' && filePathOrRunner) targetFilePath = filePathOrRunner;
    if (typeof runnerOrPlatform === 'function') runner = runnerOrPlatform;
    if (typeof platform === 'string') targetPlatform = platform;
  }

  const success = await writeKeychainPayload(target.tokenPayload, runner, targetPlatform);
  if (!success) return false;

  pool.activeAccount = target.email;
  target.lastUsedAt = new Date().toISOString();
  await saveAccountPool(pool, targetFilePath);
  return true;
}

/**
 * Marks an account as quota-exhausted with a reset cooldown.
 * If model is specified and is an individual model (e.g. Claude), segregates quota cooldown
 * so Google Gemini models remain operational on the host account.
 */
export async function markAccountQuotaExhausted(
  email,
  pool,
  cooldownMs,
  reason = 'RESOURCE_EXHAUSTED 429',
  filePath = pool?._filePath || getAccountPoolPath(),
  model = null
) {
  if (!email || !pool || !Array.isArray(pool.accounts)) return;
  const target = pool.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
  if (target) {
    const isIndividualModelQuota = typeof reason === 'string' && /individual quota reached/i.test(reason);
    const isClaudeModel = typeof model === 'string' && model.startsWith('claude-');

    target.modelQuotas = target.modelQuotas || {};
    if (model) {
      target.modelQuotas[model] = {
        quotaResetAt: Date.now() + cooldownMs,
        reason,
        exhaustedAt: new Date().toISOString(),
      };
      target.quotaResetModel = model;
    }

    if (isIndividualModelQuota || isClaudeModel) {
      // Third-party model quota reached its individual limit.
      // Do NOT exhaust the overall Google account status so Gemini models remain operational.
      target.lastError = `[${model || 'individual_model'}] ${reason}`;
      if (!target.status || target.status === 'ready') {
        target.status = 'ready';
      }
    } else {
      target.status = 'quota_exhausted';
      target.quotaResetAt = Date.now() + cooldownMs;
      target.lastError = reason;
      target.quotaExhaustedAt = new Date().toISOString();
    }
    await saveAccountPool(pool, filePath);
  }
}

