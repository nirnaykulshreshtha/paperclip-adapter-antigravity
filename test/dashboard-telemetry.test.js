import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWithHelpers, extractToolTarget, formatToolProgress } from '../src/server/execute.js';
import { fixture, helpers ,testDeps} from './fixtures.js';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('extractToolTarget formats subagents, tasks, schedule, and file tools', () => {
  assert.equal(
    extractToolTarget('invoke_subagent', { Role: 'Codebase Researcher', Prompt: 'Investigate dashboard' }),
    'Codebase Researcher: Investigate dashboard'
  );
  assert.equal(
    extractToolTarget('manage_subagents', { Action: 'list' }),
    'list subagents'
  );
  assert.equal(
    extractToolTarget('manage_task', { Action: 'status', TaskId: 'task-42' }),
    'status task-42'
  );
  assert.equal(
    extractToolTarget('schedule', { DurationSeconds: 300 }),
    '300s'
  );
  assert.equal(
    extractToolTarget('run_command', { CommandLine: 'pnpm test' }),
    'pnpm test'
  );
  assert.equal(
    extractToolTarget('replace_file_content', { TargetFile: 'src/index.js' }),
    'src/index.js'
  );
  assert.equal(
    extractToolTarget('search_web', { query: 'antigravity cli docs' }),
    'antigravity cli docs'
  );
});

test('adapter emits onRuntimeProgress, onEvent, and ACPX log streams during execution', async (t) => {
  const f = await fixture(t);
  const exe = path.join(f.root, 'agy-telemetry-stub');

  // Stub that simulates a complete agent lifecycle: init -> user_input -> thinking/response -> tool -> done -> result
  await writeFile(exe, `#!/usr/bin/env node
let chunks = '';
process.stdin.on('data', d => chunks += d);
process.stdin.on('end', () => {
  // 1. Init event
  console.log(JSON.stringify({
    event: 'init',
    conversation_id: 'conv-telem-123',
    init: {
      tools: ['run_command', 'replace_file_content', 'invoke_subagent', 'search_web'],
      permission_mode: 'sandbox'
    }
  }));

  // 2. User input step
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: 'conv-telem-123', step_index: 0, state: 'DONE', step_type: 'user_input' }
  }));

  // 3. Agent response step
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: 'conv-telem-123', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'I will inspect ' }
  }));
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: 'conv-telem-123', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'the files.' }
  }));

  // 4. Tool call: run_command
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-telem-123',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' } }
    }
  }));
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-telem-123',
      step_index: 2,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      duration_seconds: 0.12,
      tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' }, output: 'total 0' }
    }
  }));

  // 5. Tool call: invoke_subagent (internal harness)
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-telem-123',
      step_index: 3,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'invoke_subagent',
      tool_info: { name: 'invoke_subagent', parameters: { Role: 'Researcher', Prompt: 'Check docs' } }
    }
  }));
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-telem-123',
      step_index: 3,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'invoke_subagent',
      duration_seconds: 0.45,
      tool_info: { name: 'invoke_subagent', parameters: { Role: 'Researcher' }, output: 'Found docs' }
    }
  }));

  // 6. Usage update
  console.log(JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-telem-123',
      step_index: 4,
      state: 'DONE',
      step_type: 'agent_response',
      usage: { input_tokens: 1500, output_tokens: 200, thinking_tokens: 50, total_tokens: 1700 }
    }
  }));

  // 7. Result
  console.log(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'conv-telem-123',
      status: 'SUCCESS',
      response: 'All inspections completed successfully.',
      duration_seconds: 1.2,
      usage: { input_tokens: 1500, output_tokens: 200, cache_read_tokens: 100, total_tokens: 1700 }
    }
  }));
});
`);
  await chmod(exe, 0o755);

  const runtimeProgress = [];
  const events = [];
  const logs = [];

  const ctx = {
    runId: 'run-telem-1',
    agent: { id: 'agent-1', companyId: 'comp-1', name: 'Lead Dev' },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: 'task-telem' },
    config: {
      command: exe,
      cwd: f.secondary,
      allowedWorkspaceRoot: f.secondary,
      executionMode: 'planning',
      model: 'gemini-3.8-flash-high',
      validateSelectedModelOnRun: false,
      timeoutSec: 30,
      traceDirectory: path.join(f.root, 'traces'),
    },
    context: { taskId: 'task-telem', taskTitle: 'Telemetry test' },
    authToken: 'token-secret-123',
    onLog: async (stream, text) => logs.push({ stream, text }),
    onRuntimeProgress: async (p) => runtimeProgress.push(p),
    onEvent: async (e) => events.push(e),
    onSpawn: async () => {},
  };

  const res = await executeWithHelpers(ctx, helpers, testDeps);
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.ok(res.resultJson.efficiency.toolCalls > 0);
  assert.equal(res.resultJson.efficiency.toolCalls, events.filter(e => e.eventType === 'tool.execution.started').length);

  // 1. Verify onRuntimeProgress captures stages and currentToolName
  assert.ok(runtimeProgress.length >= 5, `Expected at least 5 progress updates, got ${runtimeProgress.length}`);
  const startupProg = runtimeProgress.find(p => p.phase === 'adapter_startup');
  assert.ok(startupProg, 'Expected adapter_startup progress update');
  assert.match(startupProg.message, /Starting Antigravity harness/);

  const toolActiveProg = runtimeProgress.find(p => p.currentToolName === 'run_command');
  assert.ok(toolActiveProg, 'Expected progress with currentToolName=run_command');
  assert.match(toolActiveProg.message, /(?:Using|Running) run_command: ls -la/);

  const subagentProg = runtimeProgress.find(p => p.currentToolName === 'invoke_subagent');
  assert.ok(subagentProg, 'Expected progress with currentToolName=invoke_subagent');
  assert.match(subagentProg.message, /Researcher/);

  const finalizeProg = runtimeProgress.find(p => p.phase === 'finalize');
  assert.ok(finalizeProg, 'Expected finalize progress update');
  assert.equal(finalizeProg.message, 'Execution completed');

  // 2. Verify onEvent captures harness and lifecycle events
  const eventTypes = events.map(e => e.eventType);
  assert.ok(eventTypes.includes('harness.starting'), 'Expected harness.starting event');
  assert.ok(eventTypes.includes('harness.ready'), 'Expected harness.ready event');
  assert.ok(eventTypes.includes('session.started'), 'Expected session.started event');
  assert.ok(eventTypes.includes('turn.started'), 'Expected turn.started event');
  assert.ok(eventTypes.includes('tool.execution.started'), 'Expected tool.execution.started event');
  assert.ok(eventTypes.includes('tool.execution.completed'), 'Expected tool.execution.completed event');
  assert.ok(eventTypes.includes('delegation.started'), 'Expected delegation.started event for subagent');
  assert.ok(eventTypes.includes('delegation.completed'), 'Expected delegation.completed event for subagent');
  assert.ok(eventTypes.includes('usage.reported'), 'Expected usage.reported event');
  assert.ok(eventTypes.includes('turn.completed'), 'Expected turn.completed event');
  assert.ok(eventTypes.includes('harness.exited'), 'Expected harness.exited event');

  // 3. Verify onLog emits structured ACPX lines for Paperclip web UI
  const stdoutLines = logs.filter(l => l.stream === 'stdout').map(l => l.text);
  const acpxSession = stdoutLines.find(l => l.includes('"acpx.session"'));
  assert.ok(acpxSession, 'Expected acpx.session in stdout logs');
  const sessionObj = JSON.parse(acpxSession);
  assert.equal(sessionObj.agent, 'antigravity');
  assert.equal(sessionObj.sessionId, 'conv-telem-123');

  const acpxDelta = stdoutLines.find(l => l.includes('"acpx.text_delta"'));
  assert.ok(acpxDelta, 'Expected acpx.text_delta in stdout logs');

  const acpxToolCall = stdoutLines.find(l => l.includes('"acpx.tool_call"'));
  assert.ok(acpxToolCall, 'Expected acpx.tool_call in stdout logs');
  const toolCallObj = JSON.parse(acpxToolCall);
  assert.equal(toolCallObj.name, 'run_command');

  const acpxToolResult = stdoutLines.find(l => l.includes('"acpx.tool_result"'));
  assert.ok(acpxToolResult, 'Expected acpx.tool_result in stdout logs');

  const acpxResult = stdoutLines.find(l => l.includes('"acpx.result"'));
  assert.ok(acpxResult, 'Expected acpx.result in stdout logs');
  const resultObj = JSON.parse(acpxResult);
  assert.equal(resultObj.isError, false);
  assert.equal(resultObj.inputTokens, 1500);

  // 4. Token secrecy: secrets must never leak into log records
  assert.ok(!JSON.stringify(logs).includes('token-secret-123'), 'Secret auth token must be redacted');
});
