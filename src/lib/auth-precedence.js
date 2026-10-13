export const ANTIGRAVITY_SANDBOX_AUTH_PRECEDENCE_WARNING =
  'snapshot login present but configured or host credentials take precedence';
export const ANTIGRAVITY_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE =
  `[paperclip] Warning: ${ANTIGRAVITY_SANDBOX_AUTH_PRECEDENCE_WARNING}.\n`;

/**
 * Precedence hierarchy for Antigravity adapter execution:
 * 1. configured_api_key (explicit API key injected into config or env)
 * 2. host_keychain (local developer / host authenticated via macOS keychain or CLI status)
 * 3. cached_company_auth (identity-anchored company cache auth.json)
 * 4. sandbox_auth_json (credentials restored inside ephemeral runtime container)
 * 5. none (unauthenticated)
 */
export function resolveAntigravityAuthPrecedence(input) {
  const winner = input.configuredApiKey
    ? 'configured_api_key'
    : input.hostKeychain
      ? 'host_keychain'
      : input.cachedCompanyAuth
        ? 'cached_company_auth'
        : input.sandboxAuthJson
          ? 'sandbox_auth_json'
          : 'none';

  const sandboxLoginShadowed = Boolean(
    input.sandboxAuthJson &&
    (winner === 'configured_api_key' || winner === 'host_keychain' || winner === 'cached_company_auth')
  );

  return {
    winner,
    sandboxLoginShadowed,
    shouldWarn: sandboxLoginShadowed,
  };
}
