/**
 * Probe diagnostics and safe hint normalization for Paperclip Antigravity adapter.
 * Ensures untrusted terminal text and credentials never leak into UI check text or server logs.
 */

export const ADAPTER_TEST_HOST_TARGET_LABEL = 'Paperclip host';

const ALLOWED_LOGIN_URL_HOST_SUFFIXES = ['google.com', 'accounts.google.com'];
const MAX_ERROR_CLASS_NAME_CHARS = 64;

/**
 * Returns constructor name of an Error, or null for non-error.
 */
export function classifyThrownErrorClass(err) {
  if (err instanceof Error) return err.constructor?.name ?? 'Error';
  return null;
}

/**
 * Sanitizes an error class name to bounded identifier characters.
 */
export function sanitizeErrorClassName(name) {
  if (typeof name !== 'string') return null;
  const safe = name.replace(/[^A-Za-z0-9_$]/g, '').slice(0, MAX_ERROR_CLASS_NAME_CHARS);
  return safe.length > 0 ? safe : null;
}

/**
 * Logs structured diagnostic context to console.warn without leaking raw strings.
 */
export function logAntigravityProbeDiagnostic(context, classification, fields = {}) {
  const detail = { classification };
  if (typeof fields.exitCode === 'number' && Number.isFinite(fields.exitCode)) {
    detail.exitCode = fields.exitCode;
  }
  const errorClass = sanitizeErrorClassName(fields.errorClass);
  if (errorClass) detail.errorClass = errorClass;
  console.warn(`[paperclip] ${context}`, detail);
}

/**
 * Normalizes an untrusted login URL for a Test-result hint.
 * Rejects non-https, userinfo, ports, query strings, hashes, or non-Google domains.
 */
export function normalizeAntigravityLoginUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;
  if (url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_LOGIN_URL_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
  if (!allowed) return null;
  return url.toString();
}

/**
 * Builds user-facing login hint with safe URL and optional user pairing code.
 */
export function buildAntigravityLoginRequiredHint(loginUrl, userCode) {
  const safeUrl = normalizeAntigravityLoginUrl(loginUrl);
  const safeCode = typeof userCode === 'string' && /^[A-Za-z0-9-_]{3,30}$/.test(userCode.trim())
    ? userCode.trim()
    : null;
  if (safeUrl && safeCode) {
    return `Run \`agy auth login\` and enter code ${safeCode} at ${safeUrl}, then retry.`;
  }
  if (safeUrl) {
    return `Run \`agy auth login\` and complete sign-in at ${safeUrl}, then retry.`;
  }
  return 'Run `agy auth login` in this environment, then retry the probe.';
}

/**
 * Resolves safe display label for the probed target environment.
 */
export function resolveAdapterTestTargetLabel(input = {}) {
  if (!input.targetIsRemote) return ADAPTER_TEST_HOST_TARGET_LABEL;
  const name = typeof input.environmentName === 'string' ? input.environmentName.trim() : '';
  return name.length > 0 ? name : 'the selected environment';
}

/**
 * Builds the canonical environment target check carried by all test results.
 */
export function buildAdapterTestTargetCheck(input = {}) {
  const label = resolveAdapterTestTargetLabel(input);
  return {
    code: 'antigravity_environment_target',
    level: 'info',
    message: input.targetIsRemote
      ? `Probing inside environment: ${label}`
      : 'Probing on the Paperclip host.',
  };
}
