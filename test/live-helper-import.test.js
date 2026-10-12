import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeContext } from './fixtures.js';
import { execute } from '../src/server/execute.js';
test('public execute resolves the declared real Paperclip helper dependency', async t => {
  const f = await fixture(t);
  const { ctx } = fakeContext(f.config);
  const result = await execute(ctx);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});

test('missing host API token fails before provider dispatch instead of falling back to board identity', async t => {
  const f = await fixture(t);
  const { ctx, spawned } = fakeContext(f.config);
  delete ctx.authToken;
  const result = await execute(ctx);
  assert.match(result.errorMessage, /host-issued run-scoped Paperclip API token/);
  assert.equal(spawned.length, 0);
});
test('adapter advertises support for host-issued local agent JWTs', async () => {
  const { createServerAdapter } = await import('../src/index.js');
  assert.equal(createServerAdapter().supportsLocalAgentJwt, true);
});
