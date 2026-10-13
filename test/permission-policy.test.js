import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, fakeContext, helpers, testDeps } from './fixtures.js';
import { executeWithHelpers } from '../src/server/execute.js';

const projectId = '6753d82c-1585-4ff5-9f4b-0d8e04b65bf3';

test('planning mode permits always-proceed unattended runtime in Paperclip workspace', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.paperclip-antigravity-allow'), 'ALLOW_PAPERCLIP_ANTIGRAVITY_LOCAL\n');
  const cfg = {
    ...f.config,
    cwd: f.primary,
    repositoryRoot: f.primary,
    allowedWorkspaceRoot: f.root,
    workspaceMode: 'paperclip',
    executionMode: 'planning',
  };
  const { ctx } = fakeContext(cfg, 'SCENARIO_AUTO_APPROVE');
  ctx.context.paperclipWorkspace = { cwd: f.secondary, workspaceId: 'ws-test', projectId };
  const result = await executeWithHelpers(ctx, helpers, testDeps);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});

test('planning mode permits always-proceed in legacy fixed worktree', async (t) => {
  const f = await fixture(t);
  const cfg = {
    ...f.config,
    cwd: f.secondary,
    allowedWorkspaceRoot: f.root,
    workspaceMode: 'fixed',
    executionMode: 'planning',
  };
  const { ctx } = fakeContext(cfg, 'SCENARIO_AUTO_APPROVE');
  const result = await executeWithHelpers(ctx, helpers, testDeps);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});

test('implementation mode permits always-proceed when authorized via approvedIssueIds', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.paperclip-antigravity-allow'), 'ALLOW_PAPERCLIP_ANTIGRAVITY_LOCAL\n');
  const cfg = {
    ...f.config,
    cwd: f.primary,
    repositoryRoot: f.primary,
    allowedWorkspaceRoot: f.root,
    workspaceMode: 'paperclip',
    executionMode: 'implementation',
    enableImplementation: true,
    approvedIssueIds: ['issue-456'],
    approvedProjectIds: [],
  };
  const { ctx } = fakeContext(cfg, 'SCENARIO_AUTO_APPROVE');
  ctx.context.issueId = 'issue-456';
  ctx.context.paperclipWorkspace = { cwd: f.secondary, workspaceId: 'ws-test', projectId: '00000000-0000-0000-0000-000000000000' };
  const result = await executeWithHelpers(ctx, helpers, testDeps);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});

test('implementation mode permits always-proceed in verified fixed worktree', async (t) => {
  const f = await fixture(t);
  const cfg = {
    ...f.config,
    cwd: f.secondary,
    allowedWorkspaceRoot: f.root,
    workspaceMode: 'fixed',
    executionMode: 'implementation',
    enableImplementation: true,
  };
  const { ctx } = fakeContext(cfg, 'SCENARIO_AUTO_APPROVE');
  const result = await executeWithHelpers(ctx, helpers, testDeps);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});

test('disabling allowUnattendedRuntime fails closed with structured permission_denied classification', async (t) => {
  const f = await fixture(t);
  const cfg = {
    ...f.config,
    cwd: f.secondary,
    allowedWorkspaceRoot: f.root,
    workspaceMode: 'fixed',
    executionMode: 'planning',
    allowUnattendedRuntime: false,
  };
  const { ctx } = fakeContext(cfg, 'SCENARIO_AUTO_APPROVE');
  const result = await executeWithHelpers(ctx, helpers, testDeps);
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorCode, 'permission_denied');
  assert.equal(result.resultJson?.errorFamily, 'permission');
  assert.match(result.errorMessage, /permission policy is unsafe/i);
});
