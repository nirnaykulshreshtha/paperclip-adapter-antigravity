import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Parses raw keyring base64 payload into authenticated account info.
 */
export function parseKeyringPayload(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const b64 = trimmed.startsWith('go-keyring-base64:')
    ? trimmed.slice('go-keyring-base64:'.length)
    : trimmed;

  try {
    const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
    const data = JSON.parse(jsonStr);
    let email = null;
    let name = null;

    if (typeof data.id_token === 'string' && data.id_token.includes('.')) {
      const parts = data.id_token.split('.');
      if (parts.length >= 2) {
        try {
          const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
          const claims = JSON.parse(payload);
          email = claims.email || null;
          name = claims.name || null;
        } catch {}
      }
    }

    const expiry = data.token?.expiry || null;
    const expired = expiry ? new Date(expiry).getTime() <= Date.now() : false;

    return {
      email,
      name,
      authMethod: data.auth_method || 'consumer',
      expiry,
      expired,
    };
  } catch {
    return null;
  }
}

/**
 * Detects the currently active authenticated account from the system keyring or CLI state.
 * Injectable runner for unit tests.
 */
export async function detectActiveAccount(runner = execFileAsync, platform = process.platform) {
  if (process.env.NODE_ENV === 'test' && !process.env.PAPERCLIP_ANTIGRAVITY_LIVE_KEYCHAIN) {
    if (process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD) {
      return parseKeyringPayload(process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD);
    }
    return null;
  }
  if (platform === 'darwin') {
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
      const parsed = parseKeyringPayload(stdout);
      if (parsed) return parsed;
    } catch {
      // Keyring query failed or item not found
    }
  }
  return null;
}

/**
 * Resolves an alternative cross-provider model pool when a quota limit (429) is hit.
 * Antigravity maintains segregated quota pools:
 * - Google pool: gemini-*
 * - Anthropic pool: claude-*
 * - GPT pool: gpt-oss-*
 */
export function resolveQuotaFallbackModel(currentModel, availableModels = []) {
  if (typeof currentModel !== 'string' || !currentModel.trim()) return null;
  const cur = currentModel.trim();
  const list = Array.isArray(availableModels) && availableModels.length > 0 ? availableModels : null;

  let candidates = [];
  if (cur.startsWith('gemini-')) {
    candidates = ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'];
  } else if (cur.startsWith('claude-')) {
    candidates = ['gemini-3.8-flash-high', 'gpt-oss-120b-medium', 'gemini-3.1-pro-high'];
  } else {
    candidates = ['claude-sonnet-4-6', 'gemini-3.8-flash-high'];
  }

  for (const cand of candidates) {
    if (cand === cur) continue;
    if (!list || list.includes(cand)) return cand;
  }

  return null;
}
