import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  copyBackAntigravityAuth,
  decideAntigravityAuthMerge,
  readSubscriptionAccountId,
  USE_SOURCE_EXIT,
  KEEP_DESTINATION_EXIT,
  IMPLAUSIBLE_LAST_REFRESH_EXIT,
} from '../src/lib/auth-cache.js';

test('readSubscriptionAccountId extracts account email or id', () => {
  assert.equal(readSubscriptionAccountId({ email: 'user@example.com' }), 'user@example.com');
  assert.equal(readSubscriptionAccountId({ accountId: 'acc_123' }), 'acc_123');
  assert.equal(readSubscriptionAccountId(JSON.stringify({ account_id: 'acc_456' })), 'acc_456');
  assert.equal(readSubscriptionAccountId('invalid json'), null);
});

test('decideAntigravityAuthMerge returns USE_SOURCE when destination is absent', () => {
  const source = { email: 'user@example.com', timestamp: 1000 };
  assert.equal(decideAntigravityAuthMerge(source, null), USE_SOURCE_EXIT);
});

test('decideAntigravityAuthMerge compares timestamps for same identity', () => {
  const older = { email: 'user@example.com', timestamp: 1000 };
  const newer = { email: 'user@example.com', timestamp: 2000 };
  // Sandbox newer -> adopt source
  assert.equal(decideAntigravityAuthMerge(newer, older), USE_SOURCE_EXIT);
  // Sandbox older -> keep destination
  assert.equal(decideAntigravityAuthMerge(older, newer), KEEP_DESTINATION_EXIT);
});

test('decideAntigravityAuthMerge keeps destination if identities differ', () => {
  const source = { email: 'userA@example.com', timestamp: 2000 };
  const dest = { email: 'userB@example.com', timestamp: 1000 };
  assert.equal(decideAntigravityAuthMerge(source, dest), KEEP_DESTINATION_EXIT);
});

test('decideAntigravityAuthMerge rejects implausible future timestamp (clock skew)', () => {
  const now = 100000;
  const source = { email: 'user@example.com', timestamp: now + 10 * 60 * 1000 }; // 10 min in future
  const dest = { email: 'user@example.com', timestamp: 50000 };
  assert.equal(decideAntigravityAuthMerge(source, dest, { now }), IMPLAUSIBLE_LAST_REFRESH_EXIT);
});

test('copyBackAntigravityAuth returns kept-host when sandbox credential is ENOENT', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copyback-test-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const hostAuthPath = path.join(tempDir, 'host', 'auth.json');
  const outcome = await copyBackAntigravityAuth({
    readSandboxAuth: async () => {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    },
    hostAuthPath,
    log: async () => {},
  });

  assert.equal(outcome, 'kept-host');
});

test('copyBackAntigravityAuth installs strictly newer sandbox credential to host', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copyback-test-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const hostDir = path.join(tempDir, 'host');
  await fs.mkdir(hostDir, { recursive: true });
  const hostAuthPath = path.join(hostDir, 'auth.json');
  await fs.writeFile(hostAuthPath, JSON.stringify({ email: 'user@example.com', timestamp: 1000 }));

  const sandboxAuthBytes = Buffer.from(JSON.stringify({ email: 'user@example.com', timestamp: 2000, refreshedToken: 'abc' }));

  const logs = [];
  const outcome = await copyBackAntigravityAuth({
    readSandboxAuth: async () => sandboxAuthBytes,
    hostAuthPath,
    log: async (msg) => logs.push(msg),
  });

  assert.equal(outcome, 'copied');
  const updatedHost = JSON.parse(await fs.readFile(hostAuthPath, 'utf8'));
  assert.equal(updatedHost.refreshedToken, 'abc');
  assert.equal(updatedHost.timestamp, 2000);
});
