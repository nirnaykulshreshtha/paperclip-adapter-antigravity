// Pure JavaScript UI parser for Antigravity CLI adapter runs in Paperclip.
// Self-contained, zero external runtime dependencies. Runs inside sandboxed browser Web Worker.

function safeJson(str) {
  if (typeof str !== 'string' || !str.trim()) return null;
  const first = str.trimStart()[0];
  if (first !== '{' && first !== '[') return null;
  try {
    const val = JSON.parse(str);
    return typeof val === 'object' && val !== null ? val : null;
  } catch {
    return null;
  }
}

function stringify(val) {
  if (typeof val === 'string') return val;
  if (val === null || val === undefined) return '';
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

function pickToolUseId(p) {
  return String(p.toolCallId || p.toolUseId || p.id || p.callId || p.executionId || '');
}

export function parseStdoutLine(line, ts) {
  if (typeof line !== 'string') return [];
  const trimmed = line.trim();
  if (!trimmed) return [];

  const parsed = safeJson(trimmed);
  if (parsed && typeof parsed.type === 'string') {
    const type = parsed.type;

    if (type === 'acpx.session') {
      const agent = String(parsed.agent || 'agy');
      const mode = parsed.mode ? String(parsed.mode) : '';
      const perm = parsed.permissionMode ? String(parsed.permissionMode) : '';
      const label = [mode, perm].filter(Boolean).join(' / ');
      return [{
        kind: 'init',
        ts,
        model: label ? `${agent} (${label})` : agent,
        sessionId: String(parsed.acpSessionId || parsed.sessionId || parsed.runtimeSessionName || ''),
      }];
    }

    if (type === 'acpx.text_delta') {
      const text = String(parsed.text || '');
      if (!text) return [];
      const ch = String(parsed.channel || parsed.stream || '');
      return [{
        kind: ch === 'thought' || ch === 'thinking' ? 'thinking' : 'assistant',
        ts,
        text,
        delta: true,
      }];
    }

    if (type === 'acpx.tool_call') {
      const toolName = String(parsed.name || 'tool');
      const toolUseId = pickToolUseId(parsed) || `tool-${Date.now()}`;
      const status = String(parsed.status || 'in_progress');
      const args = parsed.input ?? parsed.parameters ?? parsed.args;
      const input = args && typeof args === 'object'
        ? args
        : (args !== undefined ? { raw: args } : (parsed.text ? { detail: parsed.text } : {}));

      const entries = [{
        kind: 'tool_call',
        ts,
        name: toolName,
        toolUseId,
        input,
        target: parsed.target ?? null,
        startedAt: parsed.startedAt ?? null,
      }];

      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        const content = stringify(parsed.output ?? parsed.content ?? parsed.error ?? parsed.text ?? status);
        entries.push({
          kind: 'tool_result',
          ts,
          toolUseId,
          toolName,
          content,
          isError: status !== 'completed',
          durationMs: parsed.durationMs,
          outputTruncated: parsed.outputTruncated === true,
          error: parsed.error ?? null,
        });
      }
      return entries;
    }

    if (type === 'acpx.tool_result') {
      const toolUseId = pickToolUseId(parsed) || 'tool-result';
      const toolName = String(parsed.name || parsed.toolName || 'tool');
      const content = stringify(parsed.content ?? parsed.output ?? parsed.error);
      const isError = parsed.isError === true || parsed.error !== undefined || parsed.status === 'failed';

      return [{
        kind: 'tool_result',
        ts,
        toolUseId,
        toolName,
        content,
        isError,
        durationMs: parsed.durationMs,
        outputTruncated: parsed.outputTruncated === true,
        error: parsed.error ?? null,
      }];
    }

    if (type === 'acpx.status') {
      return [{
        kind: 'system',
        ts,
        text: String(parsed.text || parsed.tag || 'status'),
      }];
    }

    if (type === 'acpx.result') {
      return [{
        kind: 'result',
        ts,
        text: String(parsed.summary || parsed.stopReason || parsed.text || ''),
        inputTokens: Number(parsed.inputTokens) || 0,
        outputTokens: Number(parsed.outputTokens) || 0,
        cachedTokens: Number(parsed.cachedTokens) || 0,
        costUsd: Number(parsed.costUsd) || 0,
        subtype: String(parsed.subtype || parsed.stopReason || 'acpx.result'),
        isError: parsed.isError === true,
        errors: Array.isArray(parsed.errors) ? parsed.errors.map(stringify).filter(Boolean) : [],
      }];
    }

    if (type === 'acpx.error') {
      return [{
        kind: 'stderr',
        ts,
        text: String(parsed.message || line),
      }];
    }

    if (type.startsWith('acpx.')) {
      return [{
        kind: 'system',
        ts,
        text: String(parsed.message || type),
      }];
    }
  }

  // Handle raw Antigravity CLI stream JSON lines
  if (parsed && typeof parsed.step_type === 'string') {
    if (parsed.step_type === 'agent_response' && parsed.text_delta) {
      return [{
        kind: 'assistant',
        ts,
        text: String(parsed.text_delta),
        delta: true,
      }];
    }

    if (parsed.step_type === 'tool') {
      const toolName = String(parsed.tool_name || parsed.tool_info?.name || 'tool');
      const toolUseId = `tool-${parsed.step_index ?? Date.now()}`;
      const params = (parsed.tool_info?.parameters ?? parsed.tool_info?.args ?? parsed.args ?? {});

      if (parsed.state === 'ACTIVE') {
        return [{
          kind: 'tool_call',
          ts,
          name: toolName,
          toolUseId,
          input: typeof params === 'object' && params !== null ? params : { raw: params },
          target: parsed.tool_info?.target ?? null,
          startedAt: parsed.started_at ?? null,
        }];
      }

      if (parsed.state === 'DONE') {
        const isError = Boolean(parsed.tool_info?.error);
        const out = parsed.tool_info?.output ?? parsed.tool_info?.error?.message ?? parsed.tool_info?.error;
        return [{
          kind: 'tool_result',
          ts,
          toolUseId,
          toolName,
          content: stringify(out),
          isError,
          durationMs: typeof parsed.duration_seconds === 'number' ? Math.round(parsed.duration_seconds * 1000) : undefined,
          error: parsed.tool_info?.error ?? null,
        }];
      }
    }

    if (parsed.step_type === 'result') {
      const usage = parsed.usage || {};
      return [{
        kind: 'result',
        ts,
        text: String(parsed.text || 'Turn completed'),
        inputTokens: Number(usage.input_tokens) || 0,
        outputTokens: Number(usage.output_tokens) || 0,
        cachedTokens: Number(usage.cache_read_input_tokens) || 0,
        costUsd: Number(parsed.cost_usd) || 0,
        subtype: 'agy.turn_completed',
        isError: false,
        errors: [],
      }];
    }
  }

  // Handle formatted tool bracket lines
  if (trimmed.startsWith('[tool:')) {
    const endBracket = trimmed.indexOf(']');
    if (endBracket > 6) {
      const toolName = trimmed.slice(6, endBracket);
      const detail = trimmed.slice(endBracket + 1).trim();
      const toolUseId = `tool-${Date.now()}`;
      return [{
        kind: 'tool_call',
        ts,
        name: toolName,
        toolUseId,
        input: { detail },
      }];
    }
  }

  if (trimmed.startsWith('[tool_done:')) {
    const endBracket = trimmed.indexOf(']');
    if (endBracket > 11) {
      const toolName = trimmed.slice(11, endBracket);
      const detail = trimmed.slice(endBracket + 1).trim();
      const toolUseId = `tool-${Date.now()}`;
      return [{
        kind: 'tool_result',
        ts,
        toolUseId,
        toolName,
        content: detail,
        isError: detail.includes('failed') || detail.includes('error'),
      }];
    }
  }

  return [{ kind: 'stdout', ts, text: line }];
}

// CJS & worker shims for web worker execution
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseStdoutLine };
}
if (typeof exports !== 'undefined') {
  exports.parseStdoutLine = parseStdoutLine;
}
