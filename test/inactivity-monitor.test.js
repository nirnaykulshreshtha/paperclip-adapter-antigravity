import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveInactivityTimeout,
  formatInactivityErrorMessage,
  createOutputInactivityMonitor,
  DEFAULT_ANTIGRAVITY_OUTPUT_INACTIVITY_TIMEOUT_MS,
} from '../src/lib/inactivity-monitor.js';

test('resolveInactivityTimeout handles null, numbers, and default', () => {
  assert.deepEqual(resolveInactivityTimeout(null), { mode: 'disabled', reason: 'explicit_null' });
  assert.deepEqual(resolveInactivityTimeout(60_000), { mode: 'configured', timeoutMs: 60_000 });
  assert.deepEqual(resolveInactivityTimeout(undefined), {
    mode: 'default',
    timeoutMs: DEFAULT_ANTIGRAVITY_OUTPUT_INACTIVITY_TIMEOUT_MS,
  });
  assert.deepEqual(resolveInactivityTimeout(-5), {
    mode: 'default',
    timeoutMs: DEFAULT_ANTIGRAVITY_OUTPUT_INACTIVITY_TIMEOUT_MS,
    reason: 'non_positive',
  });
});

test('formatInactivityErrorMessage outputs canonical message', () => {
  const msg = formatInactivityErrorMessage(65_000);
  assert.equal(msg, 'monitor: no antigravity activity (output or process) for 1m 5s');
});

test('createOutputInactivityMonitor fires when inactive and resets on output chunks', async () => {
  let fired = false;
  let firedState = null;

  const monitor = createOutputInactivityMonitor({
    timeoutMs: 40,
    onFire: (state) => {
      fired = true;
      firedState = state;
    },
  });

  // Keep alive with chunk
  await new Promise((r) => setTimeout(r, 20));
  monitor.noteOutputChunk('stdout', 'chunk-1');
  assert.equal(fired, false);

  // Allow to expire
  await new Promise((r) => setTimeout(r, 55));
  assert.equal(fired, true);
  assert.ok(firedState);
  assert.equal(firedState.outputChunkCount, 1);

  monitor.stop();
});

test('createOutputInactivityMonitor stops cleanly without firing', async () => {
  let fired = false;
  const monitor = createOutputInactivityMonitor({
    timeoutMs: 20,
    onFire: () => { fired = true; },
  });

  monitor.stop();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, false);
});
