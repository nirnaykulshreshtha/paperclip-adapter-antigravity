import path from 'node:path';
import fs from 'node:fs/promises';
import { detectActiveAccount } from './account.js';
import { resolveAntigravityAuthCacheDir, resolveAntigravityAuthCacheEntryPath, readAntigravityAuthCacheEntry } from './auth-cache.js';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Evaluates whether Antigravity credentials are ready to launch an execution.
 * Checks the 4-tier precedence hierarchy:
 * 1. configured_api_key (ANTIGRAVITY_API_KEY, GEMINI_API_KEY, or config apiKey)
 * 2. host_keychain (active account via system keychain or agy statusline)
 * 3. cached_company_auth (company-scoped cache auth.json)
 * 4. sandbox_auth_json (sandbox container authentication)
 */
export async function evaluateAntigravityCredentialReadiness(input = {}) {
  const env = input.env ?? process.env;
  const configuredApiKey = nonEmpty(
    input.configuredApiKey ?? input.apiKey ?? input.config?.apiKey ?? env.ANTIGRAVITY_API_KEY ?? env.GEMINI_API_KEY
  );

  if (configuredApiKey) {
    return {
      ready: true,
      authMode: 'api',
      source: 'configured_api_key',
    };
  }

  // Check host keychain / statusline / active account
  const activeAccount = input.activeAccount !== undefined
    ? input.activeAccount
    : await detectActiveAccount().catch(() => null);

  if (activeAccount?.email && !activeAccount.expired) {
    return {
      ready: true,
      authMode: 'subscription',
      source: 'host_keychain',
      account: activeAccount.email,
    };
  }

  // Check company auth cache
  const companyId = input.companyId || 'default';
  try {
    if (input.accountId) {
      const entryPath = resolveAntigravityAuthCacheEntryPath(env, input.accountId, companyId);
      const data = await readAntigravityAuthCacheEntry(entryPath);
      if (data && !data.expired) {
        return {
          ready: true,
          authMode: 'subscription',
          source: 'cached_company_auth',
          account: input.accountId,
          entryPath,
        };
      }
    } else {
      const cacheRoot = resolveAntigravityAuthCacheDir(env, companyId);
      const entries = await fs.readdir(cacheRoot).catch(() => []);
      for (const entry of entries) {
        const entryPath = path.join(cacheRoot, entry, 'auth.json');
        const data = await readAntigravityAuthCacheEntry(entryPath);
        if (data && !data.expired) {
          return {
            ready: true,
            authMode: 'subscription',
            source: 'cached_company_auth',
            account: entry,
            entryPath,
          };
        }
      }
    }
  } catch {}

  // Check sandbox auth
  if (input.sandboxAuthJson) {
    return {
      ready: true,
      authMode: 'subscription',
      source: 'sandbox_auth_json',
    };
  }

  return {
    ready: false,
    authMode: 'subscription',
    source: 'none',
    reason: 'No configured API key, active host keychain account, or cached company authentication found.',
  };
}
