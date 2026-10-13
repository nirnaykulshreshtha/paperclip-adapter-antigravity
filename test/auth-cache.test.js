import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveAntigravityAuthCacheDir,
  resolveAntigravityAuthCacheEntryPath,
  ensureAntigravityAuthCacheEntryDir,
  writeAntigravityAuthCacheEntry,
  readAntigravityAuthCacheEntry,
  toCacheKey,
} from '../src/lib/auth-cache.js';

test('toCacheKey sanitizes safe path segments and rejects traversal', () => {
  assert.equal(toCacheKey('user_123'), 'user_123');
  assert.throws(() => toCacheKey(''), /empty/);
  assert.throws(() => toCacheKey('..'), /relative path segment/);
  assert.throws(() => toCacheKey('../hack'), /path separator/);
  assert.throws(() => toCacheKey('foo/bar'), /path separator/);
});

test('resolveAntigravityAuthCacheEntryPath builds safe company-scoped path', () => {
  const fakeEnv = { PAPERCLIP_HOME: '/opt/paperclip' };
  const entryPath = resolveAntigravityAuthCacheEntryPath(fakeEnv, 'user-1', 'company-a');
  assert.ok(entryPath.includes('/opt/paperclip/instances/default/companies/company-a/antigravity-auth-cache/user-1/auth.json'));
});

test('writeAntigravityAuthCacheEntry and readAntigravityAuthCacheEntry write with atomic locks', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'agy-cache-test-'));
  const fakeEnv = { PAPERCLIP_HOME: tempDir };

  try {
    const entryPath = await ensureAntigravityAuthCacheEntryDir(fakeEnv, 'account-test', 'company-xyz');
    const data = { access_token: 'valid-test-token', email: 'dev@example.com' };
    const buf = Buffer.from(JSON.stringify(data));

    const status = await writeAntigravityAuthCacheEntry({
      authBytes: buf,
      cacheEntryPath: entryPath,
      env: fakeEnv,
    });

    assert.equal(status, 'written');
    const read = await readAntigravityAuthCacheEntry(entryPath);
    assert.deepEqual(read, data);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
