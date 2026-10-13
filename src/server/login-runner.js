export const ANTIGRAVITY_DEVICE_LOGIN_COMMAND = 'agy auth login --device-auth';
export const ANTIGRAVITY_LOGIN_URL_RE = /(https:\/\/accounts\.google\.com\/[^\s]+|https:\/\/[^\s]*oauth[^\s]*)/i;
export const ANTIGRAVITY_CODE_RE = /(?:code|pairing code|enter code|enter the following code)[:\s]+([A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?)/i;

/**
 * Parses login URL and user verification code from terminal login output.
 */
export function parseDeviceLoginPrompt(output) {
  if (typeof output !== 'string') return null;
  const urlMatch = ANTIGRAVITY_LOGIN_URL_RE.exec(output);
  const codeMatch = ANTIGRAVITY_CODE_RE.exec(output);
  if (!urlMatch && !codeMatch) return null;

  return {
    url: urlMatch ? urlMatch[1] : null,
    code: codeMatch ? codeMatch[1] : null,
    rawPrompt: output.trim(),
  };
}

/**
 * Executes a headless device-login run using an injected PTY driver.
 * Follows Paperclip SandboxLoginDriver lifecycle specifications:
 * - Emits onPrompt when login URL or code is parsed.
 * - On success, reads credential file via driver.readFile without logging raw tokens.
 * - Automatically disposes driver on all terminal states.
 */
export async function runDeviceLogin(driver, options = {}) {
  const {
    command = ANTIGRAVITY_DEVICE_LOGIN_COMMAND,
    onPrompt,
    onCredential,
    authPath,
    timeoutMs = 120_000,
    parsePrompt = parseDeviceLoginPrompt,
  } = options;

  let accumulated = '';
  let promptSurfaced = false;
  let timer = null;

  try {
    const outcome = await new Promise(async (resolve, reject) => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          resolve({ outcome: 'timed_out', exitCode: null });
        }, timeoutMs);
      }

      try {
        const res = await driver.start(command, (chunk) => {
          accumulated += chunk;
          if (!promptSurfaced && typeof onPrompt === 'function') {
            const prompt = parsePrompt(accumulated);
            if (prompt) {
              promptSurfaced = true;
              try { onPrompt(prompt); } catch {}
            }
          }
        });

        if (res.exitCode === 0) {
          resolve({ outcome: 'success', exitCode: 0 });
        } else {
          resolve({ outcome: 'failed', exitCode: res.exitCode });
        }
      } catch (err) {
        reject(err);
      }
    });

    if (timer) clearTimeout(timer);

    if (outcome.outcome === 'success' && authPath && typeof onCredential === 'function') {
      try {
        const credBytes = await driver.readFile(authPath);
        if (credBytes && credBytes.length > 0) {
          await onCredential(credBytes);
        }
      } catch (err) {
        return { outcome: 'credential_read_failed', exitCode: outcome.exitCode };
      }
    }

    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    if (driver && typeof driver.dispose === 'function') {
      await driver.dispose().catch(() => {});
    }
  }
}
