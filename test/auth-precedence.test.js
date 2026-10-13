import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAntigravityAuthPrecedence } from '../src/lib/auth-precedence.js';

test('configured API key takes highest precedence', () => {
  const result = resolveAntigravityAuthPrecedence({
    configuredApiKey: true,
    hostKeychain: true,
    cachedCompanyAuth: true,
    sandboxAuthJson: true,
  });

  assert.equal(result.winner, 'configured_api_key');
  assert.equal(result.sandboxLoginShadowed, true);
  assert.equal(result.shouldWarn, true);
});

test('host keychain takes precedence over cached company and sandbox credentials', () => {
  const result = resolveAntigravityAuthPrecedence({
    configuredApiKey: false,
    hostKeychain: true,
    cachedCompanyAuth: true,
    sandboxAuthJson: true,
  });

  assert.equal(result.winner, 'host_keychain');
  assert.equal(result.sandboxLoginShadowed, true);
  assert.equal(result.shouldWarn, true);
});

test('cached company auth wins over sandbox login when host keychain is absent', () => {
  const result = resolveAntigravityAuthPrecedence({
    configuredApiKey: false,
    hostKeychain: false,
    cachedCompanyAuth: true,
    sandboxAuthJson: true,
  });

  assert.equal(result.winner, 'cached_company_auth');
  assert.equal(result.sandboxLoginShadowed, true);
  assert.equal(result.shouldWarn, true);
});

test('sandbox auth wins when no other credentials exist', () => {
  const result = resolveAntigravityAuthPrecedence({
    configuredApiKey: false,
    hostKeychain: false,
    cachedCompanyAuth: false,
    sandboxAuthJson: true,
  });

  assert.equal(result.winner, 'sandbox_auth_json');
  assert.equal(result.sandboxLoginShadowed, false);
  assert.equal(result.shouldWarn, false);
});

test('returns none when completely unauthenticated', () => {
  const result = resolveAntigravityAuthPrecedence({
    configuredApiKey: false,
    hostKeychain: false,
    cachedCompanyAuth: false,
    sandboxAuthJson: false,
  });

  assert.equal(result.winner, 'none');
  assert.equal(result.sandboxLoginShadowed, false);
  assert.equal(result.shouldWarn, false);
});
