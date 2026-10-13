import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_TEST_HOST_TARGET_LABEL,
  classifyThrownErrorClass,
  sanitizeErrorClassName,
  logAntigravityProbeDiagnostic,
  normalizeAntigravityLoginUrl,
  buildAntigravityLoginRequiredHint,
  resolveAdapterTestTargetLabel,
  buildAdapterTestTargetCheck,
} from '../src/lib/probe-diagnostics.js';

test('classifyThrownErrorClass extracts constructor name and handles nulls', () => {
  assert.equal(classifyThrownErrorClass(new TypeError('boom')), 'TypeError');
  assert.equal(classifyThrownErrorClass(new Error('fail')), 'Error');
  assert.equal(classifyThrownErrorClass('plain string'), null);
  assert.equal(classifyThrownErrorClass(null), null);
});

test('sanitizeErrorClassName bounds length and strips non-ident characters', () => {
  assert.equal(sanitizeErrorClassName('TypeError'), 'TypeError');
  assert.equal(sanitizeErrorClassName('Bad<script>alert(1)</script>'), 'Badscriptalert1script');
  assert.equal(sanitizeErrorClassName(123), null);
  assert.equal(sanitizeErrorClassName(''), null);
  const longName = 'A'.repeat(100);
  assert.equal(sanitizeErrorClassName(longName).length, 64);
});

test('normalizeAntigravityLoginUrl accepts valid google oauth urls', () => {
  assert.equal(
    normalizeAntigravityLoginUrl('https://accounts.google.com/o/oauth2/auth'),
    'https://accounts.google.com/o/oauth2/auth'
  );
  assert.equal(
    normalizeAntigravityLoginUrl('https://www.google.com/device'),
    'https://www.google.com/device'
  );
  assert.equal(
    normalizeAntigravityLoginUrl('https://google.com'),
    'https://google.com/'
  );
});

test('normalizeAntigravityLoginUrl rejects unsafe, malformed or non-google urls', () => {
  // Non-https
  assert.equal(normalizeAntigravityLoginUrl('http://accounts.google.com'), null);
  // With query parameters (might contain token or state)
  assert.equal(normalizeAntigravityLoginUrl('https://accounts.google.com/auth?token=secret'), null);
  // With hash fragment
  assert.equal(normalizeAntigravityLoginUrl('https://accounts.google.com#token'), null);
  // With user info or port
  assert.equal(normalizeAntigravityLoginUrl('https://user:pass@accounts.google.com'), null);
  assert.equal(normalizeAntigravityLoginUrl('https://accounts.google.com:8080'), null);
  // Untrusted domain
  assert.equal(normalizeAntigravityLoginUrl('https://evil.com/google.com'), null);
  assert.equal(normalizeAntigravityLoginUrl('https://notgoogle.com'), null);
  assert.equal(normalizeAntigravityLoginUrl('not a url'), null);
  assert.equal(normalizeAntigravityLoginUrl(null), null);
});

test('buildAntigravityLoginRequiredHint formats hint with safe url and user code', () => {
  assert.equal(
    buildAntigravityLoginRequiredHint('https://www.google.com/device', 'ABCD-1234'),
    'Run `agy auth login` and enter code ABCD-1234 at https://www.google.com/device, then retry.'
  );
  assert.equal(
    buildAntigravityLoginRequiredHint('https://www.google.com/device'),
    'Run `agy auth login` and complete sign-in at https://www.google.com/device, then retry.'
  );
  assert.equal(
    buildAntigravityLoginRequiredHint('invalid url'),
    'Run `agy auth login` in this environment, then retry the probe.'
  );
});

test('resolveAdapterTestTargetLabel and buildAdapterTestTargetCheck format target checks', () => {
  assert.equal(resolveAdapterTestTargetLabel({ targetIsRemote: false }), ADAPTER_TEST_HOST_TARGET_LABEL);
  assert.equal(resolveAdapterTestTargetLabel({ targetIsRemote: true, environmentName: 'staging-box' }), 'staging-box');
  assert.equal(resolveAdapterTestTargetLabel({ targetIsRemote: true }), 'the selected environment');

  const localCheck = buildAdapterTestTargetCheck({ targetIsRemote: false });
  assert.equal(localCheck.code, 'antigravity_environment_target');
  assert.equal(localCheck.level, 'info');
  assert.ok(localCheck.message.includes('Paperclip host'));

  const remoteCheck = buildAdapterTestTargetCheck({ targetIsRemote: true, environmentName: 'prod' });
  assert.ok(remoteCheck.message.includes('prod'));
});

test('logAntigravityProbeDiagnostic logs warning with structured fields', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    logAntigravityProbeDiagnostic('probe failed', 'auth_missing', { exitCode: 1, errorClass: 'AuthError' });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], '[paperclip] probe failed');
    assert.deepEqual(warnings[0][1], { classification: 'auth_missing', exitCode: 1, errorClass: 'AuthError' });
  } finally {
    console.warn = origWarn;
  }
});
