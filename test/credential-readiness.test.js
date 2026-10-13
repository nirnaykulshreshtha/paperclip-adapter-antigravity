import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { evaluateAntigravityCredentialReadiness } from '../src/lib/credential-readiness.js';
import { writeAntigravityAuthCacheEntry } from '../src/lib/auth-cache.js';

test('credential readiness detects configured API key as ready in api mode', async () => {
  const result = await evaluateAntigravityCredentialReadiness({
    configuredApiKey: 'test-api-key-123',
  });
  assert.equal(result.ready, true);
  assert.equal(result.authMode, 'api');
  assert.equal(result.source, 'configured_api_key');
});

test('credential readiness detects environment API keys as ready', async () => {
  const result = await evaluateAntigravityCredentialReadiness({
    env: { ANTIGRAVITY_API_KEY: 'test-env-key-456' },
  });
  assert.equal(result.ready, true);
  assert.equal(result.authMode, 'api');
  assert.equal(result.source, 'configured_api_key');
});

test('credential readiness detects active host keychain account', async () => {
  const result = await evaluateAntigravityCredentialReadiness({
    activeAccount: { email: 'developer@example.com', expired: false },
    env: {},
  });
  assert.equal(result.ready, true);
  assert.equal(result.authMode, 'subscription');
  assert.equal(result.source, 'host_keychain');
  assert.equal(result.account, 'developer@example.com');
});

test('credential readiness rejects expired host keychain account', async () => {
  const result = await evaluateAntigravityCredentialReadiness({
    activeAccount: { email: 'developer@example.com', expired: true },
    env: {},
  });
  assert.equal(result.ready, false);
  assert.equal(result.authMode, 'subscription');
  assert.equal(result.source, 'none');
});

test('credential readiness detects cached company auth when present', async (t) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-readiness-test-'));
  t.after(() => fs.rm(tempHome, { recursive: true, force: true }));

  const env = { PAPERCLIP_HOME: tempHome, PAPERCLIP_INSTANCE_ID: 'inst1' };
  const companyId = 'co_readiness';
  const accountId = 'user-ready@example.com';

  const cacheRoot = path.join(tempHome, 'instances', 'inst1', 'companies', companyId, 'antigravity-auth-cache', accountId);
  await fs.mkdir(cacheRoot, { recursive: true });
  const entryPath = path.join(cacheRoot, 'auth.json');

  await writeAntigravityAuthCacheEntry({
    authBytes: JSON.stringify({ email: accountId, timestamp: Date.now() }),
    cacheEntryPath: entryPath,
    env,
  });

  const result = await evaluateAntigravityCredentialReadiness({
    companyId,
    accountId,
    activeAccount: null,
    env,
  });

  assert.equal(result.ready, true);
  assert.equal(result.authMode, 'subscription');
  assert.equal(result.source, 'cached_company_auth');
  assert.equal(result.account, accountId);
});

test('credential readiness recognizes sandbox auth flag when present', async () => {
  const result = await evaluateAntigravityCredentialReadiness({
    activeAccount: null,
    sandboxAuthJson: true,
    env: {},
  });
  assert.equal(result.ready, true);
  assert.equal(result.authMode, 'subscription');
  assert.equal(result.source, 'sandbox_auth_json');
});

test('credential readiness returns not ready when no credentials exist', async () => {
  const result = await evaluateAntigravityCredentialReadiness({
    activeAccount: null,
    env: {},
  });
  assert.equal(result.ready, false);
  assert.equal(result.authMode, 'subscription');
  assert.equal(result.source, 'none');
  assert.ok(result.reason.includes('No configured API key'));
});
