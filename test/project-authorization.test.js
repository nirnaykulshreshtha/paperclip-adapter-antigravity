import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, fakeContext, helpers ,testDeps} from './fixtures.js';
import { normalizeConfig } from '../src/lib/config.js';
import { executeWithHelpers } from '../src/server/execute.js';
const projectId = '6753d82c-1585-4ff5-9f4b-0d8e04b65bf3';
async function setup(t) {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.paperclip-antigravity-allow'), 'ALLOW_PAPERCLIP_ANTIGRAVITY_LOCAL\n');
  const cfg = { ...f.config, cwd: f.primary, repositoryRoot: f.primary,
    allowedWorkspaceRoot: f.root, workspaceMode: 'paperclip', executionMode: 'implementation',
    enableImplementation: true, approvedIssueIds: [], approvedProjectIds: [projectId] };
  const state = fakeContext(cfg);
  state.ctx.context.paperclipWorkspace = { cwd: f.secondary, workspaceId: 'ws-test', projectId };
  return { ...state, cfg };
}
test('operator project authorization permits a new assigned issue in its verified isolated workspace', async t => {
  const { ctx } = await setup(t);
  const result = await executeWithHelpers(ctx, helpers, testDeps);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});
test('project authorization refuses a different project or missing host project identity before spawning', async t => {
  const { ctx, spawned } = await setup(t);
  for (const identity of ['00000000-0000-0000-0000-000000000000', undefined]) {
    ctx.context.paperclipWorkspace.projectId = identity;
    const result = await executeWithHelpers(ctx, helpers, testDeps);
    assert.match(result.errorMessage, /no explicit issue or isolated project implementation authorization/);
  }
  assert.equal(spawned.length, 0);
});
test('project authorization still refuses absent task and workspace identity', async t => {
  const { ctx, spawned } = await setup(t);
  delete ctx.context.paperclipWorkspace.workspaceId;
  assert.match((await executeWithHelpers(ctx, helpers, testDeps)).errorMessage, /workspace ID/);
  assert.equal(spawned.length, 0);
});
test('project authorization validates operator configuration and cannot enable fixed checkout coding', async t => {
  const { cfg } = await setup(t);
  assert.throws(() => normalizeConfig({ ...cfg, approvedProjectIds: ['arbitrary'] }), /valid project UUIDs/);
  assert.throws(() => normalizeConfig({ ...cfg, workspaceMode: 'fixed' }), /isolated workspaces/);
  assert.throws(() => normalizeConfig({ ...cfg, enableImplementation: false }), /enableImplementation/);
});

test('explicit unattended policy applies only in the approved verified project; default still rejects auto tools', async t => {
  const { ctx, cfg } = await setup(t);
  cfg.allowUnattendedRuntime = false;
  ctx.context.taskTitle = 'SCENARIO_AUTO_APPROVE';
  assert.match((await executeWithHelpers(ctx, helpers, testDeps)).errorMessage, /permission policy is unsafe/);
  cfg.allowUnattendedRuntime = true;
  assert.equal((await executeWithHelpers(ctx, helpers, testDeps)).exitCode, 0);
  ctx.context.paperclipWorkspace.projectId = '00000000-0000-0000-0000-000000000000';
  assert.match((await executeWithHelpers(ctx, helpers, testDeps)).errorMessage, /no explicit issue or isolated project implementation authorization/);
});
