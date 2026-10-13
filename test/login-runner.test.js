import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDeviceLogin, parseDeviceLoginPrompt } from '../src/server/login-runner.js';

test('parseDeviceLoginPrompt extracts Google OAuth login url and user pairing code', () => {
  const output = `
To sign in, use a web browser to open the page:
https://accounts.google.com/o/oauth2/device/user
and enter the following code: ABCD-EFGH
`;

  const parsed = parseDeviceLoginPrompt(output);
  assert.ok(parsed);
  assert.equal(parsed.url, 'https://accounts.google.com/o/oauth2/device/user');
  assert.equal(parsed.code, 'ABCD-EFGH');
});

test('runDeviceLogin streams terminal output, emits onPrompt and reads credential on success', async () => {
  let disposed = false;
  let receivedPrompt = null;
  let receivedCredential = null;

  const mockDriver = {
    async start(command, onData) {
      assert.ok(command.includes('auth login'));
      onData('Please visit https://accounts.google.com/o/oauth2/device/user and enter code: WXYZ-1234\n');
      return { exitCode: 0 };
    },
    async readFile(filePath) {
      assert.equal(filePath, '/tmp/mock-agy-auth.json');
      return Buffer.from(JSON.stringify({ access_token: 'fake-token' }));
    },
    async dispose() {
      disposed = true;
    },
  };

  const result = await runDeviceLogin(mockDriver, {
    authPath: '/tmp/mock-agy-auth.json',
    onPrompt: (p) => { receivedPrompt = p; },
    onCredential: (c) => { receivedCredential = c; },
  });

  assert.equal(result.outcome, 'success');
  assert.equal(result.exitCode, 0);
  assert.ok(receivedPrompt);
  assert.equal(receivedPrompt.code, 'WXYZ-1234');
  assert.ok(receivedCredential);
  assert.equal(disposed, true);
});

test('runDeviceLogin disposes driver on failure exit', async () => {
  let disposed = false;
  const mockDriver = {
    async start(command, onData) {
      return { exitCode: 1 };
    },
    async readFile() {
      return Buffer.alloc(0);
    },
    async dispose() {
      disposed = true;
    },
  };

  const result = await runDeviceLogin(mockDriver, {
    onPrompt: () => {},
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.exitCode, 1);
  assert.equal(disposed, true);
});
