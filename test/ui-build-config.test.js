import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAntigravityLocalConfig } from '../src/ui/build-config.js';
import { parseStdoutLine } from '../src/ui/parse-stdout.js';

test('buildAntigravityLocalConfig normalizes UI form inputs', () => {
  const values = {
    command: '/custom/bin/agy',
    model: 'gemini-3.8-flash',
    effort: 'high',
    workspaceMode: 'paperclip',
    repositoryRoot: '/path/to/repo',
    allowedWorkspaceRoot: '/path/to/worktrees',
    executionMode: 'implementation',
    enableImplementation: true,
    approvedIssueIds: 'ISSUE-101, ISSUE-102',
    approvedProjectIds: ['00000000-0000-0000-0000-000000000001'],
    allowUnattendedRuntime: true,
    timeoutSec: 450,
    graceSec: 15,
    probeAuthentication: true,
    promptPolicy: 'compact_resume',
  };

  const config = buildAntigravityLocalConfig(values);
  assert.equal(config.command, '/custom/bin/agy');
  assert.equal(config.model, 'gemini-3.8-flash');
  assert.equal(config.effort, 'high');
  assert.equal(config.workspaceMode, 'paperclip');
  assert.equal(config.repositoryRoot, '/path/to/repo');
  assert.equal(config.allowedWorkspaceRoot, '/path/to/worktrees');
  assert.equal(config.executionMode, 'implementation');
  assert.equal(config.enableImplementation, true);
  assert.deepEqual(config.approvedIssueIds, ['ISSUE-101', 'ISSUE-102']);
  assert.deepEqual(config.approvedProjectIds, ['00000000-0000-0000-0000-000000000001']);
  assert.equal(config.allowUnattendedRuntime, true);
  assert.equal(config.timeoutSec, 450);
  assert.equal(config.graceSec, 15);
  assert.equal(config.promptPolicy, 'compact_resume');
});

test('UI package exports both parseStdoutLine and buildAntigravityLocalConfig', async () => {
  const ui = await import('../src/ui/index.js');
  assert.equal(typeof ui.parseStdoutLine, 'function');
  assert.equal(typeof ui.buildAntigravityLocalConfig, 'function');
});
