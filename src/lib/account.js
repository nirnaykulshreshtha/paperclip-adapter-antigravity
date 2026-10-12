import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readObservedStatus } from './statusline.js';

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
  // The TUI statusline is a fresh observation, not a credential authority.
  const observed = await readObservedStatus().catch(() => null);
  if (observed?.email) return {email:observed.email,name:null,authMethod:'cli',source:'agy_statusline',observedAt:observed.observedAt,model:observed.model};
  if (process.env.NODE_ENV === 'test' && !process.env.PAPERCLIP_ANTIGRAVITY_LIVE_KEYCHAIN) {
    if (process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD) {
      return {...parseKeyringPayload(process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD),source:'keychain'};
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
      if (parsed) return {...parsed,source:'keychain'};
    } catch {
      // Keyring query failed or item not found
    }
  }
  return null;
}

/** Optional macOS keychain observation. Never returns raw credentials. */
export async function detectHeadlessKeychainAccount(runner=execFileAsync,platform=process.platform) {
  if(process.env.NODE_ENV==='test' && !process.env.PAPERCLIP_ANTIGRAVITY_LIVE_KEYCHAIN)
    return process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD ? parseKeyringPayload(process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD) : null;
  if(platform!=='darwin')return null;
  try {
    const {stdout}=await runner('security',['find-generic-password','-s','gemini','-a','antigravity','-w'],
      {timeout:3000,encoding:'utf8',windowsHide:true});
    return parseKeyringPayload(stdout);
  }catch{return null;}
}
