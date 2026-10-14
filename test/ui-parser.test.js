import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStdoutLine } from '../src/ui/parse-stdout.js';

test('ui parser parses acpx.session into init card', () => {
  const ts = new Date().toISOString();
  const line = JSON.stringify({
    type: 'acpx.session',
    agent: 'antigravity',
    mode: 'implementation',
    sessionId: 'session-xyz',
  });
  const entries = parseStdoutLine(line, ts);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'init');
  assert.equal(entries[0].sessionId, 'session-xyz');
  assert.match(entries[0].model, /antigravity/);
});

test('ui parser parses acpx.text_delta into assistant and thinking', () => {
  const ts = new Date().toISOString();
  const outLine = JSON.stringify({
    type: 'acpx.text_delta',
    text: 'Hello world',
    channel: 'output',
  });
  const outEntries = parseStdoutLine(outLine, ts);
  assert.equal(outEntries.length, 1);
  assert.equal(outEntries[0].kind, 'assistant');
  assert.equal(outEntries[0].text, 'Hello world');

  const thinkLine = JSON.stringify({
    type: 'acpx.text_delta',
    text: 'Reasoning step',
    channel: 'thought',
  });
  const thinkEntries = parseStdoutLine(thinkLine, ts);
  assert.equal(thinkEntries.length, 1);
  assert.equal(thinkEntries[0].kind, 'thinking');
  assert.equal(thinkEntries[0].text, 'Reasoning step');
});

test('ui parser parses acpx.tool_call and acpx.tool_result for run_command and file tools', () => {
  const ts = new Date().toISOString();
  // 1. Tool call in progress
  const callLine = JSON.stringify({
    type: 'acpx.tool_call',
    name: 'run_command',
    toolCallId: 'call-101',
    status: 'in_progress',
    text: 'npm test',
    input: { CommandLine: 'npm test', Cwd: '/workspace' },
  });
  const callEntries = parseStdoutLine(callLine, ts);
  assert.equal(callEntries.length, 1);
  assert.equal(callEntries[0].kind, 'tool_call');
  assert.equal(callEntries[0].name, 'run_command');
  assert.equal(callEntries[0].toolUseId, 'call-101');
  assert.equal(callEntries[0].input.CommandLine, 'npm test');

  // 2. Tool result completed
  const resultLine = JSON.stringify({
    type: 'acpx.tool_result',
    toolUseId: 'call-101',
    toolName: 'run_command',
    content: '69 tests passed\n0 failed',
    isError: false,
  });
  const resultEntries = parseStdoutLine(resultLine, ts);
  assert.equal(resultEntries.length, 1);
  assert.equal(resultEntries[0].kind, 'tool_result');
  assert.equal(resultEntries[0].toolUseId, 'call-101');
  assert.equal(resultEntries[0].content, '69 tests passed\n0 failed');
  assert.equal(resultEntries[0].isError, false);
});

test('ui parser parses subagent and background task harness tools', () => {
  const ts = new Date().toISOString();
  // Subagent invocation
  const subLine = JSON.stringify({
    type: 'acpx.tool_call',
    name: 'invoke_subagent',
    toolCallId: 'sub-202',
    status: 'in_progress',
    text: 'Researcher: "Explore repo"',
    input: {
      Subagents: [{ Role: 'Researcher', Prompt: 'Explore repo' }],
    },
  });
  const subEntries = parseStdoutLine(subLine, ts);
  assert.equal(subEntries.length, 1);
  assert.equal(subEntries[0].kind, 'tool_call');
  assert.equal(subEntries[0].name, 'invoke_subagent');
  assert.equal(subEntries[0].input.Subagents[0].Role, 'Researcher');

  // Background task management
  const taskLine = JSON.stringify({
    type: 'acpx.tool_call',
    name: 'manage_task',
    toolCallId: 'task-303',
    status: 'completed',
    text: 'status task-123',
    input: { Action: 'status', TaskId: 'task-123' },
  });
  const taskEntries = parseStdoutLine(taskLine, ts);
  assert.equal(taskEntries.length, 2); // tool_call + completed tool_result
  assert.equal(taskEntries[0].kind, 'tool_call');
  assert.equal(taskEntries[1].kind, 'tool_result');
  assert.equal(taskEntries[1].content, 'status task-123');
});

test('ui parser parses raw Antigravity CLI stream JSON lines', () => {
  const ts = new Date().toISOString();
  // Raw stream ACTIVE tool
  const rawActive = JSON.stringify({
    step_type: 'tool',
    step_index: 4,
    state: 'ACTIVE',
    tool_info: {
      name: 'view_file',
      parameters: { AbsolutePath: '/workspace/package.json' },
    },
  });
  const activeEntries = parseStdoutLine(rawActive, ts);
  assert.equal(activeEntries.length, 1);
  assert.equal(activeEntries[0].kind, 'tool_call');
  assert.equal(activeEntries[0].name, 'view_file');
  assert.equal(activeEntries[0].toolUseId, 'tool-4');

  // Raw stream DONE tool
  const rawDone = JSON.stringify({
    step_type: 'tool',
    step_index: 4,
    state: 'DONE',
    tool_info: {
      name: 'view_file',
      output: '{\n  "name": "paperclip"\n}',
    },
  });
  const doneEntries = parseStdoutLine(rawDone, ts);
  assert.equal(doneEntries.length, 1);
  assert.equal(doneEntries[0].kind, 'tool_result');
  assert.equal(doneEntries[0].toolUseId, 'tool-4');
  assert.match(doneEntries[0].content, /paperclip/);
});

test('ui parser falls back cleanly to stdout for unstructured logs', () => {
  const ts = new Date().toISOString();
  const plain = 'Building project tree...';
  const entries = parseStdoutLine(plain, ts);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'stdout');
  assert.equal(entries[0].text, plain);
});

test('raw ERROR tool updates render the actual error and duration',()=>{
 const entries=parseStdoutLine(JSON.stringify({step_type:'tool',state:'ERROR',step_index:137,tool_name:'view_file',duration_seconds:0.126028,tool_info:{error:{message:'no such file or directory'}}}),'2026-10-14T09:38:32.564Z');
 assert.equal(entries[0].kind,'tool_result');
 assert.equal(entries[0].isError,true);
 assert.equal(entries[0].durationMs,126);
 assert.match(entries[0].content,/no such file or directory/);
});
