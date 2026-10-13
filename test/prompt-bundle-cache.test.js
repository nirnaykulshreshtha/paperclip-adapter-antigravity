import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildPromptBundleKey,
  resolveManagedAntigravityPromptCacheRoot,
  preparePromptBundle,
} from '../src/lib/prompt-bundle-cache.js';

test('buildPromptBundleKey generates deterministic digest across orderings', () => {
  const key1 = buildPromptBundleKey({
    instructionsContents: '# My instructions',
    skills: [
      { runtimeName: 'beta', key: 'b', source: '/path/b' },
      { runtimeName: 'alpha', key: 'a', source: '/path/a' },
    ],
  });

  const key2 = buildPromptBundleKey({
    instructionsContents: '# My instructions',
    skills: [
      { runtimeName: 'alpha', key: 'a', source: '/path/a' },
      { runtimeName: 'beta', key: 'b', source: '/path/b' },
    ],
  });

  assert.equal(key1, key2);
  assert.match(key1, /^[0-9a-f]{64}$/);
});

test('preparePromptBundle materializes instruction file in managed cache root', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'prompt-bundle-test-'));
  const fakeEnv = { PAPERCLIP_HOME: tempDir };

  try {
    const bundle = await preparePromptBundle({
      companyId: 'corp-xyz',
      instructionsContents: '# System prompt instructions\nFollow guidelines.',
      skills: [{ runtimeName: 'test-skill', key: 'ts', source: '/tmp/skill' }],
      env: fakeEnv,
    });

    assert.ok(bundle.bundleKey);
    assert.ok(bundle.instructionsFilePath);
    assert.ok(bundle.rootDir.includes('corp-xyz/antigravity-prompt-cache'));
    assert.ok(bundle.instructionsFilePath.endsWith('instructions.md'));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('preparePromptBundle creates skill symlinks inside bundle directory', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'prompt-bundle-skills-'));
  const fakeEnv = { PAPERCLIP_HOME: tempDir };

  // Create a real skill folder
  const skillSource = path.join(tempDir, 'source-skill');
  await import('node:fs/promises').then(fs => fs.mkdir(skillSource, { recursive: true }));

  try {
    const bundle = await preparePromptBundle({
      companyId: 'corp-symlink',
      skills: [{ runtimeName: 'my-skill', key: 'ms', source: skillSource }],
      env: fakeEnv,
    });

    assert.ok(bundle.skillsHome);
    const targetLink = path.join(bundle.skillsHome, 'my-skill');
    const stat = await import('node:fs/promises').then(fs => fs.lstat(targetLink));
    assert.ok(stat.isSymbolicLink());
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

