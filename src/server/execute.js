import { realpath, access, symlink, readFile } from 'node:fs/promises';
import { createJournal } from '../lib/journal.js?v=0.6.0-performance';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeConfig } from '../lib/config.js?v=0.6.0-performance';
import { validateWorkspace, worktreeStatus, checkBranchFreshness, readInstructions } from '../lib/workspace.js';
import { resolveAssignedWorkspace } from '../lib/assigned-workspace.js';
import { stageAssignedSkills } from '../lib/skills.js?v=0.6.0-performance';
import { createStreamDelivery } from '../lib/stream-delivery.js';
import { createOrderedDelivery } from '../lib/ordered-delivery.js';
import { copyBackAntigravityAuth, resolveAntigravityHostAuthPath, resolveAntigravityAuthCacheEntryPath } from '../lib/auth-cache.js';
import { runAgy } from '../lib/process.js?v=0.6.0-performance';
import { errorText, looksLikePermissionDenial, sessionIdFrom, usageOf, isObj } from '../lib/result.js?v=0.6.0-performance';
import { usageSince } from '../lib/usage.js';
import { estimateAgyCost } from '../lib/agy-pricing.js';
import { taskContext, dependencySummary } from '../lib/task-context.js';
import { createEfficiencyTracker } from '../lib/efficiency.js?v=0.6.0-performance';
import { acquireWorkspaceLease } from '../lib/workspace-lease.js';
import { discoverAgyModels, modelsForExecution, invalidateModelValidation } from '../lib/models.js?v=0.6.0-performance';
import { detectActiveAccount, observeExecutionAccount } from '../lib/account.js?v=0.6.0-performance';
import { monitorAccount } from '../lib/account-monitor.js';
import { syncKeychainToPool, markAccountQuotaExhausted, parseQuotaResetDuration } from '../lib/account-pool.js?v=0.6.0-performance';

const safeText=(v,max=5000)=>typeof v==='string'?v.slice(0,max):'';
const maybeStr=(v)=>typeof v==='string'?v:'';
const executionTimeoutResult=cfg=>cfg ? {adapterExecutionTimeout:{timeoutSec:cfg.timeoutSec,source:cfg.timeoutSec>0?'configured':'unlimited'}} : {};

export function sha256Digest(str) {
  return 'sha256:' + createHash('sha256').update(str || '').digest('hex');
}

export function unquote(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  return v;
}

/** Extracts normalized parameters dictionary from tool event step across diverse CLI serializers. */
export function extractToolParameters(s) {
  if (!s || typeof s !== 'object') return {};
  const raw = s.tool_info?.parameters
    ?? s.tool_info?.args
    ?? s.tool_info?.arguments
    ?? s.tool_info?.input
    ?? s.parameters
    ?? s.args
    ?? s.arguments
    ?? s.input;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      return { raw: unquote(raw) };
    }
  }
  if (typeof raw === 'object' && raw !== null) {
    const res = Array.isArray(raw) ? [...raw] : { ...raw };
    for (const [k, v] of Object.entries(res)) {
      res[k] = unquote(v);
    }
    return res;
  }
  return {};
}

/** Extracts tool output content string from tool event step. */
export function extractToolOutput(s) {
  if (!s || typeof s !== 'object') return '';
  const raw = s.tool_info?.output
    ?? s.tool_info?.result
    ?? s.tool_info?.response
    ?? s.output
    ?? s.result
    ?? s.content;
  if (typeof raw === 'string') return raw;
  if (raw !== undefined && raw !== null) {
    try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
  }
  if (s.tool_info?.error) {
    return s.tool_info.error.message || String(s.tool_info.error);
  }
  return '';
}

export function mapToolOperation(toolName) {
  if (toolName === 'run_command') return 'execute';
  if (toolName === 'view_file' || toolName === 'read_url_content') return 'read';
  if (toolName === 'write_to_file' || toolName === 'replace_file_content') return 'edit';
  if (toolName === 'search_web') return 'search';
  if (toolName === 'manage_subagents' || toolName === 'manage_task') return 'list';
  return 'unknown';
}

export function isReadOnlyTool(toolName) {
  return ['view_file', 'read_url_content', 'search_web'].includes(toolName);
}

/** Extracts target description from tool parameters, supporting all Antigravity CLI tools. */
export function extractToolTarget(toolName, p) {
  if (!isObj(p)) return '';
  if (toolName === 'invoke_subagent' && Array.isArray(p.Subagents) && p.Subagents.length > 0) {
    const subs = p.Subagents.map(sub => {
      const role = sub.Role || sub.TypeName || 'subagent';
      const prompt = typeof sub.Prompt === 'string' ? sub.Prompt.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
      return prompt ? `${role}: "${prompt}"` : role;
    });
    return subs.join(', ');
  }
  if (toolName === 'invoke_subagent') {
    const role = p.Role || p.TypeName || 'subagent';
    const prompt = typeof p.Prompt === 'string' ? p.Prompt.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
    return prompt ? `${role}: ${prompt}` : role;
  }
  if (toolName === 'manage_subagents') {
    const action = p.Action || 'manage';
    const ids = Array.isArray(p.ConversationIds) ? ` [${p.ConversationIds.slice(0, 3).join(', ')}]` : '';
    return `${action}${ids} subagents`;
  }
  if (toolName === 'manage_task') {
    return [p.Action, p.TaskId].filter(Boolean).join(' ') || p.toolSummary || '';
  }
  if (toolName === 'schedule') {
    return p.CronExpression || (p.DurationSeconds ? `${p.DurationSeconds}s` : '') || p.Prompt || '';
  }
  if (toolName === 'ask_question') {
    const qCount = Array.isArray(p.questions) ? `${p.questions.length} questions` : '';
    return qCount || p.toolSummary || '';
  }
  if (toolName === 'define_subagent') {
    return p.name ? `${p.name}: ${p.description || ''}` : '';
  }
  if (typeof p.CommandLine === 'string') return p.CommandLine;
  if (typeof p.command === 'string') return p.command;
  if (typeof p.cmd === 'string') return p.cmd;
  if (typeof p.TargetFile === 'string') {
    const lines = p.StartLine ? `#L${p.StartLine}${p.EndLine ? `-${p.EndLine}` : ''}` : '';
    return `${p.TargetFile}${lines}`;
  }
  if (typeof p.AbsolutePath === 'string') {
    const lines = p.StartLine ? `#L${p.StartLine}${p.EndLine ? `-${p.EndLine}` : ''}` : '';
    return `${p.AbsolutePath}${lines}`;
  }
  if (typeof p.path === 'string') return p.path;
  if (typeof p.file === 'string') return p.file;
  if (typeof p.query === 'string') return p.query;
  if (typeof p.Url === 'string') return p.Url;
  if (typeof p.url === 'string') return p.url;
  if (typeof p.toolSummary === 'string') return p.toolSummary;
  if (typeof p.toolAction === 'string') return p.toolAction;
  if (typeof p.Instruction === 'string') return p.Instruction;
  return '';
}

/** Formats real-time tool progress into concise, human-readable terminal lines. */
export function formatToolProgress(s) {
  if (!s || s.step_type !== 'tool') return null;
  const name = s.tool_name || s.tool_info?.name || 'tool';
  if (s.state === 'ACTIVE') {
    const p = extractToolParameters(s);
    const target = extractToolTarget(name, p);
    const trimmed = target ? ` ${target.trim().replace(/\s+/g, ' ').slice(0, 160)}` : '';
    return `\n[tool:${name}]${trimmed}\n`;
  }
  if (['DONE','ERROR','CANCELED','CANCELLED','INTERRUPTED'].includes(s.state)) {
    const dur = typeof s.duration_seconds === 'number' ? ` (${s.duration_seconds.toFixed(2)}s)` : '';
    if (s.state!=='DONE' || s.tool_info?.error) {
      const errMsg = s.tool_info?.error?.message || (s.tool_info?.error ? String(s.tool_info.error) : `Tool reported ${s.state}`);
      return `[tool:${name} error]${dur} ${errMsg.slice(0, 200)}\n`;
    }
    let snippet = '';
    const rawOut = extractToolOutput(s);
    if (typeof rawOut === 'string') {
      const out = rawOut.trim();
      if (out) {
        snippet = `  ${out.slice(0, 400).replace(/\r\n/g, '\n').replace(/\n/g, '\n  ')}${out.length > 400 ? '...' : ''}\n`;
      }
    }
    return `${snippet}[tool:${name} done]${dur}\n`;
  }
  return null;
}

/** Stable task fingerprint, excluding volatile wake comments and per-run identifiers. */
export function staticTaskDigest(context = {}) {
  context = taskContext(context);
  const fields = [
    'taskId', 'issueId', 'identifier', 'taskIdentifier', 'taskTitle',
    'taskDescription', 'description', 'priority', 'parentId',
    'parentIssueId', 'parentTitle', 'parentIssueTitle', 'parentDescription',
    'dependencies',
  ];
  return sha256Digest(JSON.stringify(Object.fromEntries(fields.map(key => [key, context[key] ?? null]))));
}

/** Build a bounded prompt without duplicating arbitrary private server context. */
export function buildPrompt(ctx, cfg, instr, helpers, skillIndex = '', options = {}) {
  const context = taskContext(ctx.context);
  const bootstrap = options.workspaceCwd
    ? `## Verified execution context\nAssigned checkout: ${safeText(options.workspaceCwd, 4096)}\nBranch: ${safeText(options.workspaceBranch, 256)}\nThe assignment below is already supplied by Paperclip. Start with the relevant code and acceptance gaps. Do not rediscover identity using env, ps or repeated GETs. Use PAPERCLIP_API_URL and the host-issued PAPERCLIP_API_KEY for task updates; never print the environment or credentials. Fetch issue comments only for a missing handoff or new steering.`
    : '';
  const recoveryRunId = maybeStr(context.previousRunId) || maybeStr(context.retryOfRunId);
  const recoveryContext = recoveryRunId
    ? `## Reconciled execution continuation\nPrevious run: ${safeText(recoveryRunId, 128)}\nRecovery action: ${safeText(context.recoveryActionId ?? '', 128)}\nContinue the remaining assigned task in the current Paperclip workspace. Read the recorded recovery evidence and previous run handoff, then inspect current commits and file changes before acting. A stopped run is not proof that every action failed: verify outcomes before repeating writes, migrations, sends or external actions. Preserve completed work. If the workspace changed, use the current assigned checkout and its shared feature contracts; do not reuse paths from the interrupted conversation. Report completion only after checking the issue acceptance criteria.`
    : '';
  if (options.compactResume) {
    // AGY --conversation must already have been verified against task, account,
    // model and canonical workspace. Previously delivered instructions remain
    // in that conversation; do not keep appending them on every wake.
    const messages = [
      '## Continue assigned Paperclip task',
      'Resume the existing conversation and its approved instructions. Do not restart completed investigation or repeat already reported work. Check current worktree state and the latest task changes before acting. Keep permission, review and release gates unchanged.',
      'Completion requires evidence for every acceptance criterion. Wait for required background checks to finish and inspect their exit status and relevant output. A successful turn or elapsed time is not task completion. Record done only when no required work remains; otherwise record the actual review, blocker or continuation path in Paperclip.',
      `Task ID: ${safeText(context.taskId ?? context.issueId ?? ctx.runtime?.taskKey ?? '', 128)}`,
    ];
    if (options.repeatedInvestigation) messages.push('The verified conversation has repeated tool requests with unchanged results. Continue from its recorded findings. Repeat a read or check only to resolve a named missing fact, verify a relevant change, or satisfy a required acceptance check.');
    if (recoveryContext) messages.push(recoveryContext);
    if (bootstrap) messages.push(bootstrap);
    if (options.staticContextChanged) {
      for (const [label, value] of [
        ['Task title', context.taskTitle],
        ['Task description', context.taskDescription ?? context.description],
        ['Parent epic / issue ID', context.parentId ?? context.parentIssueId],
        ['Parent epic title', context.parentTitle ?? context.parentIssueTitle],
        ['Parent epic description', context.parentDescription],
        ['Upstream blockers / dependencies', dependencySummary(context.dependencies)],
      ]) {
        if (typeof value === 'string' && value) messages.push(`${label}: ${safeText(value, 20000)}`);
      }
    }
    for (const [label, value] of [
      ['Wake reason', context.wakeReason],
      ['Wake comment', context.wakeCommentBody],
      ['Approval status', context.approvalStatus],
    ]) {
      if (typeof value === 'string' && value) messages.push(`${label}: ${safeText(value, 4000)}`);
    }
    // Skill directories are rematerialized in a different temporary location
    // each run. Their live paths MUST be refreshed, even in a compact turn.
    if (skillIndex) messages.push(skillIndex);
    const prompt=messages.join('\n\n');
    if (Buffer.byteLength(prompt,'utf8')>cfg.maxPromptBytes) throw new Error('Resumed prompt exceeds maxPromptBytes');
    return prompt;
  }
  const templateData={
    agentId:ctx.agent.id,companyId:ctx.agent.companyId,runId:ctx.runId,
    agent:{id:ctx.agent.id,name:ctx.agent.name},
    company:{id:ctx.agent.companyId},
    run:{id:ctx.runId},context,
    taskId:context.taskId??context.issueId??'', taskTitle:context.taskTitle??'',
  };
  const main = cfg.promptTemplate || helpers.DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE || 'You are agent {{agent.id}} ({{agent.name}}).';
  const sections=[helpers.renderTemplate(main,templateData)];
  if (recoveryContext) sections.push(recoveryContext);
  if (bootstrap) sections.push(bootstrap);
  if(instr) sections.push('## Paperclip-managed agent instructions\n'+instr);
  if(skillIndex) sections.push(skillIndex);

  const wakeItems = [
    ['Task ID', context.taskId??context.issueId],
    ['Task identifier', context.identifier??context.taskIdentifier],
    ['Task title', context.taskTitle],
    ['Task priority', context.priority],
    ['Parent epic / issue ID', context.parentId??context.parentIssueId],
    ['Parent epic title', context.parentTitle??context.parentIssueTitle],
    ['Parent epic description', context.parentDescription],
    ['Upstream blockers / dependencies', dependencySummary(context.dependencies)],
    ['Task description', context.taskDescription??context.description],
    ['Wake reason', context.wakeReason],
    ['Wake comment', context.wakeCommentBody],
  ].filter(x=>typeof x[1]==='string' && x[1]).map(x=>`${x[0]}: ${safeText(x[1],20000)}`);

  if (wakeItems.length) {
    sections.push('## Wake context\n' + wakeItems.join('\n'));
  }

  if (options.graphifyAvailable || context.graphifyAvailable) {
    sections.push(`## Codebase Knowledge Graph (Graphify)\n` +
      `A pre-indexed codebase knowledge graph is active (7,500+ nodes) at \`graphify-out/graph.json\`.\n` +
      `Before running wide greps or scanning directories across the repository:\n` +
      `- Query architecture & relationships: \`graphify query "<question>"\`\n` +
      `- Trace data flow or call chain: \`graphify path "<source_symbol>" "<target_symbol>"\`\n` +
      `- Explain a component/service: \`graphify explain "<symbol_name>"\`\n` +
      `Always check the knowledge graph first to locate the right files, modules, models, and endpoints.`);
  }

  sections.push(`## Cross-Agent Squad Collaboration & Context Sharing\n` +
    `- Start by checking the assigned acceptance gaps against existing implementation and the upstream handoff. Keep a short record of files already read and verified results; reuse it within this conversation.\n` +
    `- Read targeted file ranges and batch independent reads. Reread a file or rerun a test only after relevant changes, a failure to diagnose, or a specific missing fact. Do not repeat broad repository discovery on every child task.\n` +
    `- Run focused tests for the touched scope first. Reserve full feature regression for integration/QA gates or changes that cross those boundaries. Preserve required acceptance checks; report unavailable external evidence as a precise blocker instead of repeatedly researching it.\n` +
    `- Completion is evidence-based, not time-based. Track every acceptance criterion as verified, blocked or unverified. Wait for required background commands to finish and inspect their exit status and full relevant output before claiming tests passed. Starting a command, creating a test, provider success or elapsed time does not prove the task complete.\n` +
    `- Mark the issue done only after all required acceptance checks have evidence and no follow-up remains. Use in_review for required review/approval and blocked for a concrete unmet dependency. If the turn ends with remaining work, preserve a precise progress handoff for Paperclip continuation; do not invent a successful disposition.\n` +
    `- Initial investigation budget: ${cfg.investigationBudget ?? 12} tool calls. Then produce a scoped change, a concrete verification result, or a precise blocker. Further investigation must name the unresolved question; do not restart discovery. This is guidance, not permission to skip required checks.\n` +
    `- Delivery Lead coordinates assignments; Technical Architect owns shared interface contracts; specialists own assigned implementation scopes.\n` +
    `- Children of one feature umbrella share its designated integration workspace/branch and parent issue as the source of decisions, contracts and handoffs. Read the parent and completed sibling handoffs before starting. Separate task conversations remain task-scoped.\n` +
    `- Verify that Paperclip assigned the umbrella's execution workspace. If a child has a different checkout, report the mismatch to the Delivery Lead before implementation; do not create another worktree or silently copy changes. Preserve existing commits and reconcile them through a reviewed handoff.\n` +
    `- A shared checkout requires serialized writers or explicitly disjoint file ownership. Never switch branches, reset, clean, stash or overwrite another owner's in-flight changes. Publish accepted commits and shared contract changes on the parent issue and reference them from the child.\n` +
    `- Before editing, inspect the current issue, assigned owner, dependencies, existing worktree commits and latest handoff; verify existing solutions rather than repeating research.\n` +
    `- One implementation owner per issue/file scope. Do not simultaneously rewrite another agent's files. Ask the Delivery Lead for a cross-domain child task or a scoped ownership transfer.\n` +
    `- For API/schema changes needed by another agent, publish a minimal versioned interface contract in the shared Paperclip issue before implementing consumers.\n` +
    `- On a blocker, post BLOCKED with exact dependency and unblock criterion, then stop rather than polling or doing unrelated work.\n` +
    `- At handoff, post one concise Paperclip comment: STATUS, COMMIT/BRANCH, FILES, INTERFACES, TESTS, BLOCKERS, NEXT OWNER. Avoid lengthy narratives and duplicate summaries.\n` +
    `- QA verifies the integrated change; Release promotes only after approvals. Do not mark another agent's tests or deployment as completed.`);

  sections.push(`## Repository and execution rules\nRead and comply with the repository AGENTS.md (especially Section 3.1: Context Hygiene & Anti-Looping Rules) and applicable SKILL.md.\nExecution mode: ${cfg.executionMode}. `+
    (cfg.executionMode==='planning'?'Plan and research only. Do not modify any files, run migrations, push Git changes, or deploy. If a write is needed, ask the human for permission in Paperclip and stop.':'Modify files only in the dedicated worktree; no production access, migrations or deployment without human authorization.')+
    '\nWhen a tool permission is denied, report it explicitly; do not claim success or work around the policy. Track decisions and blockers in Paperclip, and do not reveal secrets.');
  const prompt=sections.filter(Boolean).join('\n\n');
  if(Buffer.byteLength(prompt,'utf8')>cfg.maxPromptBytes)throw new Error('Prompt exceeds maxPromptBytes; shorten task context/instructions');
  return prompt;
}
/** Redact secret-shaped keys and the run-scoped bearer token before Paperclip persistence. */
export function sanitizeTelemetry(value, authToken, depth=0) {
  if (depth>12) return '[OMITTED]';
  if (typeof value==='string') return authToken?.length>4 ? value.replaceAll(authToken,'[REDACTED_TOKEN]') : value;
  if (Array.isArray(value)) return value.slice(0,150).map(x=>sanitizeTelemetry(x,authToken,depth+1));
  if (!value || typeof value!=='object') return value;
  const out={};
  for(const [key,v] of Object.entries(value).slice(0,150)) out[key] =
    /(?:password|(?:access|refresh|id|auth)[_-]?token|api[_-]?key|secret|authorization|cookie)/i.test(key)
    ? '[REDACTED]' : sanitizeTelemetry(v,authToken,depth+1);
  return out;
}
/** Official helper injection allows deterministic tests without live Paperclip or agy. */
/**
 * Execute a Paperclip turn. Live model discovery is the production default.
 * Tests may inject a deterministic discovery function through the third argument;
 * this never modifies Paperclip's exported execute(ctx) entry point.
 */
export async function executeWithHelpers(ctx, helpers, { discoverModels = discoverAgyModels, estimateCost = estimateAgyCost } = {}) {
  ctx={...ctx,config:ctx.config ?? ctx.adapterConfig ?? ctx.agent?.adapterConfig ?? {}};
  const callbackMetrics = {};
  for (const name of ['onLog', 'onEvent', 'onRuntimeProgress']) {
    const callback = ctx[name];
    if (!callback) continue;
    callbackMetrics[name] = { calls: 0, totalMs: 0, maxMs: 0 };
    ctx[name] = async (...args) => {
      const start = performance.now();
      try { return await callback(...args); }
      finally {
        const elapsed = performance.now() - start, metric = callbackMetrics[name];
        metric.calls++; metric.totalMs += elapsed; metric.maxMs = Math.max(metric.maxMs, elapsed);
      }
    };
  }
  let streamDelivery = null;
  const publication = createOrderedDelivery(async item => {
    if (item.kind==='log') await ctx.onLog(item.stream,item.text);
    else if (item.kind==='event') await ctx.onEvent?.(item.event);
    else if (item.kind==='progress') await ctx.onRuntimeProgress?.(item.value);
  });
  const deliverProgress = async value => { await streamDelivery?.flush(); if(ctx.onRuntimeProgress)await publication.append({kind:'progress',value}); };
  const operationDurationsMs = {};
  const timed = async (name, fn) => {
    const start = performance.now();
    try { return await fn(); } finally { operationDurationsMs[name] = (operationDurationsMs[name] || 0) + performance.now() - start; }
  };
  let modelValidationCacheHit = false;
  let confirmModelValidation = null;
  let spawned=false;
  let stagedSkills=null;
  let journal=null;
  let terminalWritten=false;
  let cfg=null;
  let workspaceLease=null;
  let leaseDispatched=false;
  let providerStopped=false;
  let stopAccountMonitor=null;
  const startedAt=performance.now();
  let cliStartedAt=null;
  let spawnedAfterMs=null;
  let lastPhase='initialization';
  let lastPhaseAt=startedAt;
  const phaseDurationsMs={};
  let phase='initialization';
  const trace=async(kind,data={})=>{
    const now=performance.now();
    if (kind==='phase.started' && phase!==lastPhase) {
      phaseDurationsMs[lastPhase]=(phaseDurationsMs[lastPhase]||0)+Math.round(now-lastPhaseAt);
      lastPhase=phase;
      lastPhaseAt=now;
    }
    if(journal) await journal.append(kind,{phase,elapsedMs:Math.round(now-startedAt),...data});
  };
  const emitEvent=async(event)=>{
    await streamDelivery?.flush();
    const safe=sanitizeTelemetry(event,ctx.authToken);
    await trace('paperclip.event',safe);
    if(ctx.onEvent)await publication.append({kind:'event',event:safe});
  };
  const terminal=async(status,details={})=>{if(terminalWritten)return;await publication.flush();terminalWritten=true;await trace('run.terminal',{status,...details});};
  try {
    journal=await createJournal({runId:ctx.runId,root:ctx.config?.traceDirectory,token:ctx.authToken});
    await trace('run.started',{adapter:'antigravity',runId:ctx.runId,agentId:ctx.agent?.id,taskId:ctx.runtime?.taskKey ?? ctx.context?.taskId ?? ctx.context?.issueId});
    if (typeof ctx.authToken !== 'string' || !ctx.authToken.trim()) {
      throw new Error('Antigravity execution requires a host-issued run-scoped Paperclip API token');
    }
    cfg=normalizeConfig(ctx.config);
    if (ctx.executionTarget?.kind && ctx.executionTarget.kind !== 'local') throw new Error('Only local execution targets are permitted');
    const taskKey=maybeStr(ctx.runtime?.taskKey)||maybeStr(ctx.context?.taskKey)||maybeStr(ctx.context?.taskId)||maybeStr(ctx.context?.issueId);
    const hasAssignedTask=Boolean(taskKey);

    // If Paperclip wakes the agent on a heartbeat or on-demand without an assigned issue/task,
    // handle it cleanly as an idle heartbeat check instead of crashing on worktree resolution.
    if (cfg.workspaceMode === 'paperclip' && !hasAssignedTask) {
      const idleMessage = 'No task was selected for this agent wake. Start Run now from the issue to use its assigned execution workspace; no implementation was started.';
      await ctx.onLog('stdout', JSON.stringify({ type: 'acpx.text_delta', text: idleMessage + '\n' }) + '\n');
      await terminal('success',{reason:'idle_heartbeat'});
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: 'antigravity',
        biller: 'antigravity',
        billingType: 'unknown',
        model: cfg.model,
        costStatus: 'unpriced',
        summary: `Agent ${ctx.agent?.name || 'idle'}: heartbeat completed. ${idleMessage}`,
        resultJson: {
          status: 'SUCCESS',
          conversationContinuation: 'continue_conversation_v1',
        ...executionTimeoutResult(cfg),
          response: idleMessage,
          conversation_id: null,
        },
      };
    }
    phase='workspace_validation'; await trace('phase.started');
    const workspace = cfg.workspaceMode === 'paperclip'
      ? await resolveAssignedWorkspace(ctx, cfg)
      : await validateWorkspace(cfg);
    const {cwd} = workspace;
    if (cfg.workspaceMode === 'paperclip' && cfg.executionMode === 'implementation') {
      const issueId = maybeStr(ctx.context?.issueId) || maybeStr(ctx.context?.taskId) || maybeStr(taskContext(ctx.context).taskId);
      if (!issueId || (!cfg.approvedIssueIds.includes(issueId) && !cfg.approvedProjectIds.includes(workspace.projectId))) {
        throw new Error('Implementation blocked: current issue has no explicit issue or isolated project implementation authorization');
      }
    }
    if (cfg.executionMode === 'implementation') {
      phase='workspace_lease'; await trace('phase.started');
      workspaceLease=await acquireWorkspaceLease(cwd,{runId:ctx.runId,signal:ctx.signal});
    }
    if(cfg.executionMode==='planning' && (await worktreeStatus(cwd)).length) {
      throw new Error('Planning requires a clean worktree (except the opt-in sentinel)');
    }
    // Preflight authorization must run BEFORE potentially slow external CLI discovery.
    // Unit tests inject deterministic discovery without changing production behavior.
    phase='account_detection'; await trace('phase.started');
    const {observed, active:activeAccount, validationIdentity} = await timed('accountObservation', () => observeExecutionAccount());
    const currentAccountEmail=activeAccount?.email||null;
    phase='model_validation'; await trace('phase.started');
    if (cfg.validateSelectedModelOnRun) {
      const validation = await timed('modelDiscovery', () => discoverModels === discoverAgyModels
        ? modelsForExecution({config:cfg}, validationIdentity)
        : discoverModels({config:cfg}).then(models => ({models,cacheHit:false})));
      modelValidationCacheHit = validation.cacheHit;
      confirmModelValidation = validation.confirm;
      if (!Array.isArray(validation.models) || !validation.models.some(entry => entry?.id === cfg.model)) {
        invalidateModelValidation();
        throw new Error(`Model ${cfg.model} is no longer available for the AGY account; refresh Paperclip's model list.`);
      }
    }
    if(currentAccountEmail) {
      await timed('accountPoolSync', () => syncKeychainToPool(null,cfg.accountPoolFile||undefined,activeAccount));
    }
    if (cfg.executionMode === 'implementation') {
      const behindMain = await checkBranchFreshness(cwd);
      if (behindMain > 0) {
        await emitEvent({
          eventType: 'worktree.behind_main',
          stream: 'system',
          level: 'warn',
          message: `Worktree branch '${workspace.branch}' is ${behindMain} commit(s) behind main. Consider merging main to prevent merge drift.`,
          payload: { behindCount: behindMain, cwd, branch: workspace.branch },
        });
      }
    }
    phase='skills_and_instructions'; await trace('phase.started');
    const instructions=await readInstructions(cfg.instructionsFilePath);
    stagedSkills=await stageAssignedSkills(ctx.config);

    // Ensure graphify knowledge base is accessible inside isolated worktree checkouts
    const worktreeGraphify = path.join(cwd, 'graphify-out');
    const repoGraphify = cfg.repositoryRoot ? path.join(cfg.repositoryRoot, 'graphify-out') : null;
    let hasGraphify = await access(path.join(worktreeGraphify, 'graph.json')).then(() => true).catch(() => false);
    if (!hasGraphify && repoGraphify) {
      const repoHasGraphify = await access(path.join(repoGraphify, 'graph.json')).then(() => true).catch(() => false);
      if (repoHasGraphify) {
        try {
          await symlink(repoGraphify, worktreeGraphify, 'dir');
          hasGraphify = true;
        } catch {
          hasGraphify = await access(path.join(worktreeGraphify, 'graph.json')).then(() => true).catch(() => false);
        }
      }
    }

    // Ephemeral skill staging paths change on every run; replace the changing
    // root when fingerprinting the logically identical bootstrap policy.
    const stableSkillsIndex=stagedSkills.root
      ? stagedSkills.index.replaceAll(stagedSkills.root,'[STAGED_SKILL_ROOT]')
      : stagedSkills.index;
    const promptSignature=sha256Digest(JSON.stringify({
      protocolVersion: 'efficient-task-context-v2',
      template:cfg.promptTemplate || helpers.DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE || '',
      instructions, skills:stableSkillsIndex,
      ...(stagedSkills.contentDigest ? {skillContents:stagedSkills.contentDigest} : {}),
      executionMode:cfg.executionMode, investigationBudget:cfg.investigationBudget,
    }));
    const contextFingerprint=staticTaskDigest(isObj(ctx.context) ? ctx.context : {});
    const workspaceId=maybeStr(workspace.workspaceId);
    const previous=ctx.runtime?.sessionParams;
    const oldId=sessionIdFrom(previous);
    // macOS commonly reports temp paths under /var/folders while realpath()
    // resolves them to /private/var/folders. Compare canonical directory identities,
    // not literal path spellings. Reject nonexistent, relative or moved workspaces.
    let previousCwd = null;
    if (oldId && typeof previous?.cwd === 'string' && path.isAbsolute(previous.cwd)) {
      previousCwd = await realpath(previous.cwd).catch(() => null);
    }
    const previousAccount=previous?.account||null;
    const accountChanged=Boolean(previousAccount && currentAccountEmail && previousAccount!==currentAccountEmail);
    if(currentAccountEmail) {
      await emitEvent({eventType:'account.active',stream:'system',level:'info',
        message:`Observed AGY account: ${currentAccountEmail}`,
        payload:{email:currentAccountEmail,source:activeAccount.source||'unknown',model:observed?.model??null}});
    } else {
      await emitEvent({eventType:'account.unknown',stream:'system',level:'warn',
        message:'Could not observe current AGY account; use /statusline hook in the interactive terminal'});
    }
    if(accountChanged)await emitEvent({eventType:'account.switched',stream:'system',level:'info',
      message:'AGY account changed; continuing the task conversation with the newly authenticated account',
      payload:{previousAccount,currentAccount:currentAccountEmail}});
    const modelChanged=Boolean(previous?.model && previous.model!==cfg.model);
    const previousAccountNowUnknown=Boolean(previousAccount && !currentAccountEmail);
    if(previousAccountNowUnknown) throw new Error('Cannot verify the current AGY account; reconnect authentication to continue the stored conversation.');
    // Don't silently preserve an old system policy if the role instructions
    // or assigned skill inventory have changed. Legacy sessions that predate
    // the fingerprints get one full prompt before compact continuation.
    const promptChanged=Boolean(previous?.promptSignature && previous.promptSignature!==promptSignature);
    const forceFresh=Boolean(ctx.context?.forceFreshSession || modelChanged || promptChanged);
    const canResume = Boolean(!forceFresh && oldId && previousCwd === cwd &&
      (!previous.taskKey || previous.taskKey === taskKey) &&
      (!previous.workspaceId || previous.workspaceId === workspaceId) &&
      (!previous.model || previous.model===cfg.model));
    if (oldId && !canResume && !forceFresh) {
      throw new Error('Stored conversation belongs to another workspace or task; reset the Paperclip session before retrying');
    }
    const compactResume=Boolean(cfg.promptPolicy==='compact_resume' && canResume &&
      previous?.promptSignature === promptSignature && previous?.contextFingerprint);
    const promptMode=compactResume?'compact_resume':'full';
    const prompt=buildPrompt(ctx,cfg,instructions,helpers,stagedSkills.index, {
      graphifyAvailable:hasGraphify,
      workspaceCwd:cwd,
      workspaceBranch:workspace.branch,
      compactResume,
      staticContextChanged:previous?.contextFingerprint!==contextFingerprint,
      repeatedInvestigation:canResume && previous?.repeatHistory?.results?.some(entry=>entry[1]>=2),
    });
    const buildArgs = (modelToUse, resumeConvId) => {
      const a = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox',
        '--print-timeout', '0'];
      // The CLI has no "default" mode value. Omit the override for normal
      // implementation; planning explicitly selects the supported plan mode.
      if (cfg.executionMode === 'planning') a.push('--mode=plan');
      a.push('--model', modelToUse);
      // Linked worktrees keep Git objects/indexes outside cwd. This path came
      // from Git and was verified against the explicitly trusted repository;
      // do not grant access to the primary source checkout or a context hint.
      if (workspace.gitCommonDir) a.push('--add-dir', workspace.gitCommonDir);
      if (stagedSkills.root) a.push('--add-dir', stagedSkills.root);
      if (cfg.effort) a.push('--effort', cfg.effort);
      if (cfg.cliAgent) a.push('--agent', cfg.cliAgent);
      if (resumeConvId) a.push('--conversation', resumeConvId);
      return a;
    };
    const args = buildArgs(cfg.model, canResume ? oldId : null);
    // Strictly reserved env: reject inherited agent identity and runtime API credentials.
    const inherited=Object.fromEntries(Object.entries(process.env).filter(([key,value]) =>
      typeof value==='string' && (/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z_]+|XDG_[A-Z_]+|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|HTTPS_PROXY|HTTP_PROXY|NO_PROXY)$/i.test(key))));
    const env={...inherited,...helpers.buildPaperclipEnv(ctx.agent,ctx.agentIdentity),
      ...(ctx.runtimeTools && helpers.buildRuntimeToolsEnv?helpers.buildRuntimeToolsEnv(ctx.runtimeTools):{}),
      PAPERCLIP_RUN_ID:ctx.runId, PAPERCLIP_WORKSPACE_CWD:cwd};
    const userLocalBin = path.join(process.env.HOME || '', '.local', 'bin');
    const pathParts = [userLocalBin, '/opt/homebrew/bin', '/usr/local/bin', ...(typeof env.PATH === 'string' ? env.PATH.split(':') : [])].filter(Boolean);
    env.PATH = Array.from(new Set(pathParts)).join(':');
    if (workspaceId) env.PAPERCLIP_WORKSPACE_ID=workspaceId;
    if (workspace.branch) env.PAPERCLIP_WORKSPACE_BRANCH=workspace.branch;
    // The only source of API key is Paperclip's run-scoped, host-issued token.
    if(ctx.authToken)env.PAPERCLIP_API_KEY=ctx.authToken;
    const bindings={
      PAPERCLIP_TASK_ID:maybeStr(ctx.context?.taskId)||maybeStr(ctx.context?.issueId)||maybeStr(taskContext(ctx.context).taskId),
      PAPERCLIP_WAKE_REASON:maybeStr(ctx.context?.wakeReason),
      PAPERCLIP_WAKE_COMMENT_ID:maybeStr(ctx.context?.wakeCommentId),
      PAPERCLIP_APPROVAL_ID:maybeStr(ctx.context?.approvalId),
      PAPERCLIP_APPROVAL_STATUS:maybeStr(ctx.context?.approvalStatus),
    };
    for(const [k,v] of Object.entries(bindings)) if(v)env[k]=v;
    await ctx.onMeta?.({adapterType:'antigravity_local',command:cfg.command,cwd,
      commandArgs:args,workspaceId,commandNotes:['Prompt sent via stdin; secrets omitted','Paperclip-assigned issue worktree verified','Sandbox enabled; permissions governed by agy user settings']});
    await publication.flush();
    await ctx.onCancellationReady?.();
    if(ctx.signal?.aborted)throw new Error('Canceled before dispatch');
    ctx.onDispatch?.();
    let permissionFailure=false;
    let runtimePermissionError=null;
    let logChars=0;
    let logTruncated=false;
    const log = async (stream,text) => {
      // Stream model text and sanitized tool progress. Never print raw credentials or unbounded raw data.
      if (typeof text !== 'string' || !text) return;
      if (ctx.authToken && typeof ctx.authToken === 'string' && ctx.authToken.length > 4) {
        text = text.replaceAll(ctx.authToken, '[REDACTED_TOKEN]');
      }
      if(logChars>=cfg.maxOutputBytes){logTruncated=true;return;}
      const limited=text.slice(0,Math.max(0,cfg.maxOutputBytes-logChars));
      if(limited.length<text.length)logTruncated=true;
      logChars+=limited.length;
      if(limited) await publication.append({kind:'log',stream,text:limited});
    };
    streamDelivery = createStreamDelivery({
      onText: text => log('stdout', `${JSON.stringify({type:'acpx.text_delta',text,channel:'output'})}\n`),
      onProgress: ctx.onRuntimeProgress ? value => publication.append({kind:'progress',value}) : null,
    });
    const emitAcpx = async (payload) => {
      await streamDelivery.flush();
      await log('stdout', `${JSON.stringify(payload)}\n`);
    };
    await emitAcpx({type:'acpx.status',text:`AGY account: ${currentAccountEmail || 'unverified'} · Model: ${cfg.model}`});

    let quotaObservedAt=null;
    let currentTurnProviderError=false;
    const classifyError = (p) => {
      const combined = `${p?.stderr || ''}\n${p?.reason || ''}\n${p?.final?.error || ''}`;
      const isAuth = /(?:not\s+logged\s+into|not\s+logged\s+in|login\s+required|run\s+`?agy\s+auth(?:\s+login)?`?\s+first|please\s+authenticate|token\s+source|unauthenticated|unauthorized|invalid\s+credentials|api[_ ]?key\s+(?:required|missing|invalid)|auth(?:entication)?\s+required)/i.test(combined);
      const isQuota = !isAuth && (/(?:RESOURCE_EXHAUSTED|quota|rate[-\s]?limit|token\s*limit|too\s+many\s+requests|\b429\b|billing\s+details|exceeded.*quota|out\s+of\s+quota|out\s+of\s+tokens)/i.test(combined) ||
                      (p?.code === 3 && /quota|rate\s*limit|limit|exhaust/i.test(combined)));
      const isSessionLost = /conversation.*(?:not\s+found|invalid|expired)|unknown\s+session|cannot\s+resume|failed\s+to\s+resume/i.test(combined);
      const isTurnLimit = p?.code === 53 || /(?:turn_limit|max_turns)/i.test(combined);

      if(isQuota && canResume && previous?.resumeRequired && p?.code===0 &&
        p?.final?.status==='ERROR' && p.final.response?.trim() && !p.stderr?.trim() && !currentTurnProviderError) {
        return {errorCode:'provider_result_inconsistent',errorFamily:'execution',clearSession:false,
          message:'AGY exited successfully and emitted a response, but its resumed conversation result contains a quota error without a current-turn provider error. Quota attribution may be stale; inspect the raw result before retrying.',
          resultJson:{providerResult:{status:p.final.status,error:p.final.error,quotaAttribution:'unverified'}}};
      }

      if (isTurnLimit) {
        return {
          errorCode: 'agent_turn_limit_reached',
          errorFamily: 'execution',
          message: 'Antigravity reached maximum conversation turn limit. Task should be broken down into smaller sub-tasks.',
          clearSession: false,
        };
      }
      if (isQuota) {
        const resetMatch = /resets? in\s+(?:\d+\s*(?:hours?|h|minutes?|min|m|seconds?|sec|s)\s*)+/i.exec(combined);
        const resetAt = resetMatch ? new Date((quotaObservedAt ?? Date.now()) + parseQuotaResetDuration(resetMatch[0]) - 30_000).toISOString() : null;
        const identity = currentAccountEmail || 'unverified account';
        return {
          errorCode: 'provider_quota',
          errorFamily: 'provider_quota',
          message: `Antigravity token limit / quota reached for ${identity} on ${cfg.model}.${resetMatch ? ` Provider ${resetMatch[0].toLowerCase()}.` : ''} Check quota for this account and model in AGY; another terminal may show a different account.`,
          resultJson: { quota: { account: currentAccountEmail, model: cfg.model, resetAt },
            ...(resetAt ? {providerQuotaRetryNotBefore:resetAt} : {}) },
          clearSession: true,
        };
      }
      if (isAuth) {
        return {
          errorCode: 'provider_auth_error',
          errorFamily: 'auth',
          message: 'Antigravity authentication required or account changed. Verify Google account login via agy.',
          clearSession: true,
        };
      }
      if (isSessionLost) {
        return {
          errorCode: 'session_lost',
          errorFamily: 'session',
          message: 'Antigravity conversation session invalid or expired; resetting session.',
          clearSession: true,
        };
      }
      if (p?.code === 3) {
        return {
          errorCode: 'provider_auth_error',
          errorFamily: 'auth',
          message: 'Antigravity exited 3; verify Google authentication, account selection and token quota locally',
          clearSession: true,
        };
      }
      return null;
    };

    const efficiency = createEfficiencyTracker(canResume ? previous?.repeatHistory : null);
    let lastAssistantSnippet = '';
    let toolStepCounter = 0;
    const activeToolCalls = new Map();

    let resumeConvId = canResume ? oldId : null;
    let observedConversationId = resumeConvId;
    const runArgs=buildArgs(cfg.model,resumeConvId);
    let proc = null;
    phase='cli_execution'; await trace('phase.started',{model:cfg.model,promptMode,promptBytes:Buffer.byteLength(prompt)});
    cliStartedAt=performance.now();
    // The CLI owns account selection. Never re-run side-effectful turns under a different account.
      if (workspaceLease) { await workspaceLease.markDispatch(); leaseDispatched=true; }
      proc = await runAgy({
        command: cfg.command,
        args: runArgs,
        cwd,
        env,
        prompt,
      timeoutMs:cfg.timeoutSec*1000,graceMs:cfg.graceSec*1000,maxBytes:cfg.maxOutputBytes,
      outputInactivityTimeoutMs: cfg.outputInactivityTimeoutMs,
      signal:ctx.signal,
      onSpawn:async(meta)=>{
        spawned=true;
        stopAccountMonitor=monitorAccount({initialEmail:currentAccountEmail,detect:detectActiveAccount,onChange:async(email,previousEmail)=>{
          invalidateModelValidation();
          const message=`AGY account: ${email} · Run started as ${currentAccountEmail || 'unverified'}; next run uses the newly observed account.`;
          await emitEvent({eventType:'account.changed_during_run',stream:'system',level:'warn',message,
            payload:{email,previousEmail,runAccount:currentAccountEmail,model:cfg.model}});
          await emitAcpx({type:'acpx.status',text:message});
        }});
        if (workspaceLease) await workspaceLease.markSpawn(meta.pid,meta.processGroupId);
        spawnedAfterMs=Math.round(performance.now()-startedAt);
        await trace('process.spawn',{...meta,preflightMs:spawnedAfterMs});
        await ctx.onSpawn?.(meta);
        await deliverProgress({
          phase: 'adapter_startup',
          message: `Starting Antigravity harness (${cfg.model})...`,
          currentToolName: null,
          lastAssistantSnippet: null,
          lastEventAt: new Date(),
        });
        await emitEvent({
          eventType: 'harness.starting',
          stream: 'system',
          level: 'info',
          message: `Starting Antigravity CLI harness (${cfg.model}, ${cfg.executionMode})`,
          payload: {
            harness: 'antigravity',
            model: cfg.model,
            executionMode: cfg.executionMode,
            workspace: cwd,
            pid: meta.pid,
          },
        });
      },
      onEvent:async(evt)=>{
        publication.check();
        if(evt.event==='result' && /quota|RESOURCE_EXHAUSTED/i.test(String(evt.result?.error || '')))
          quotaObservedAt ??= Date.now();
        await trace('cli.event',evt);
        if(evt.event==='step_update' && evt.step_update?.step_type==='error_message') currentTurnProviderError=true;
        if(evt.event==='init') {
          if (evt.init?.permission_mode==='always-proceed') {
            const issueId = maybeStr(ctx.context?.issueId) || maybeStr(ctx.context?.taskId) || maybeStr(taskContext(ctx.context).taskId);
            const isAuthorizedImplementation = cfg.executionMode === 'implementation' && (
              cfg.workspaceMode === 'paperclip'
                ? (cfg.approvedProjectIds.includes(workspace.projectId) || (issueId && cfg.approvedIssueIds.includes(issueId)))
                : true
            );
            const isAuthorizedPlanning = cfg.executionMode === 'planning';
            const approvedRuntime = cfg.allowUnattendedRuntime && (isAuthorizedImplementation || isAuthorizedPlanning);
            if (!approvedRuntime) {
              runtimePermissionError = 'Antigravity runtime permission policy is unsafe: AGY reported always-proceed but allowUnattendedRuntime=false. Enable Allow unattended runtime in the agent adapter configuration to use non-interactive AGY within the verified sandbox and authorized worktree.';
              await emitEvent({eventType:'harness.diagnostic',stream:'system',level:'error',message:runtimePermissionError,payload:{errorCode:'permission_denied',permissionMode:'always-proceed',allowUnattendedRuntime:cfg.allowUnattendedRuntime}});
              return false;
            }
          }
          const convId = typeof evt.conversation_id === 'string' ? evt.conversation_id : null;
          if(convId && /^[\w-]{5,200}$/.test(convId)) observedConversationId=convId;
          await emitAcpx({
            type: 'acpx.session',
            agent: 'antigravity',
            mode: cfg.executionMode,
            permissionMode: evt.init?.permission_mode || (cfg.allowUnattendedRuntime ? 'always-proceed' : 'sandbox'),
            sessionId: convId,
          });
          await emitEvent({
            eventType: 'harness.ready',
            stream: 'system',
            level: 'info',
            message: `Antigravity harness ready${convId ? ` (session ${convId})` : ''}`,
            payload: {
              harness: 'antigravity',
              conversationId: convId,
              tools: Array.isArray(evt.init?.tools) ? evt.init.tools : [],
              permissionMode: evt.init?.permission_mode,
            },
          });
          await emitEvent({
            eventType: canResume ? 'session.resumed' : 'session.started',
            stream: 'system',
            level: 'info',
            message: `Session ${convId ?? 'started'}`,
            payload: {
              sessionId: convId,
              model: cfg.model,
              mode: cfg.executionMode,
            },
          });
          await deliverProgress({
            phase: 'run_activity',
            message: `Antigravity ready (${cfg.executionMode})`,
            currentToolName: null,
            lastAssistantSnippet: null,
            lastEventAt: new Date(),
          });
        }
        if(evt.event==='step_update' && isObj(evt.step_update)) {
          const s=evt.step_update;
          if(s.step_type==='user_input' && s.state==='DONE') {
            await emitEvent({
              eventType: 'turn.started',
              stream: 'system',
              level: 'info',
              message: 'Turn started',
              payload: { stepIndex: s.step_index },
            });
          } else if(s.step_type==='agent_response' && typeof s.text_delta==='string' && s.text_delta) {
            await streamDelivery.text(s.text_delta);
            lastAssistantSnippet = (lastAssistantSnippet + s.text_delta).slice(-200).trim();
            streamDelivery.progress({
              phase: 'run_activity',
              message: lastAssistantSnippet.slice(0, 160) || 'Antigravity responding...',
              currentToolName: null,
              lastAssistantSnippet: lastAssistantSnippet.slice(0, 200),
              lastEventAt: new Date(),
            });
          } else if(s.step_type==='tool') {
            const toolName = s.tool_name || s.tool_info?.name || 'tool';
            const p = extractToolParameters(s);
            const target = extractToolTarget(toolName, p);
            const callId = String(s.step_index != null ? `tool-${s.step_index}` : (s.tool_info?.id || `tool-${++toolStepCounter}`));

            if(s.state==='ACTIVE') {
              efficiency.start(callId, toolName, p);
              activeToolCalls.set(callId, {
                toolName,
                parameters: p,
                target,
                toolAction: p.toolAction,
                toolSummary: p.toolSummary,
                startTime: Date.now(),
                startedAt: new Date().toISOString(),
              });

              await trace('tool.started',{executionId:callId,name:toolName,parameters:p,target,startedAt:activeToolCalls.get(callId).startedAt});
              const activeDesc = p.toolAction
                ? `${p.toolAction}${target ? `: ${target.slice(0, 120)}` : ''}`
                : (target ? `Running ${toolName}: ${target.slice(0, 120)}` : `Using ${toolName}`);

              await deliverProgress({
                phase: 'run_activity',
                message: activeDesc.slice(0, 180),
                currentToolName: toolName.slice(0, 80),
                lastAssistantSnippet: lastAssistantSnippet || null,
                lastEventAt: new Date(),
              });

              // Canonical Paperclip tool execution started event with required schema
              await emitEvent({
                eventType: 'tool.execution.started',
                stream: 'system',
                level: 'info',
                message: activeDesc.slice(0, 180),
                payload: {
                  schema: 'paperclip.tool.execution.v1',
                  executionId: callId,
                  transport: toolName === 'run_command' ? 'process' : 'builtin',
                  operation: mapToolOperation(toolName),
                  name: toolName === 'run_command' ? (target || 'Bash') : toolName,
                  target: target ? target.slice(0, 500) : null,
                  namespace: typeof p.Cwd === 'string' ? p.Cwd : null,
                  readOnly: isReadOnlyTool(toolName),
                  status: 'running',
                  startedAt:activeToolCalls.get(callId).startedAt,
                  durationMs: null,
                  exitCode: null,
                  progress: target ? target.slice(0, 200) : null,
                  output: '',
                  outputBytes: 0,
                  outputTruncated: false,
                  outputDigest: sha256Digest(''),
                  parameters: p,
                },
              });

              if(toolName === 'invoke_subagent') {
                const role = p.Role || p.TypeName || (Array.isArray(p.Subagents) ? p.Subagents.map(x=>x.Role||x.TypeName).join(', ') : 'subagent');
                await emitEvent({
                  eventType: 'delegation.started',
                  stream: 'system',
                  level: 'info',
                  message: `Subagent started: ${role}`,
                  payload: {
                    schema: 'paperclip.delegation.v1',
                    delegationId: callId,
                    action: 'spawn',
                    role,
                    typeName: p.TypeName,
                    subagents: p.Subagents,
                    prompt: safeText(p.Prompt || (p.Subagents ? JSON.stringify(p.Subagents) : ''), 1000),
                  },
                });
              } else if(toolName === 'search_web' || toolName === 'read_url_content') {
                await emitEvent({
                  eventType: 'research.started',
                  stream: 'system',
                  level: 'info',
                  message: `Research started: ${target || toolName}`,
                  payload: {
                    schema: 'paperclip.research.v1',
                    researchId: callId,
                    action: toolName === 'search_web' ? 'search' : 'open_page',
                    query: p.query,
                    url: p.Url || p.url,
                  },
                });
              }

              await emitAcpx({
                type: 'acpx.tool_call',
                name: toolName,
                toolCallId: callId,
                status: 'in_progress',
                text: target || toolName,
                input: p,
              });
            } else if(['DONE','ERROR','CANCELED','CANCELLED','INTERRUPTED'].includes(s.state)) {
              const saved = activeToolCalls.get(callId) || {};
              activeToolCalls.delete(callId);
              const finalParams = Object.keys(p).length > 0 ? p : (saved.parameters || {});
              const finalTarget = target || saved.target || extractToolTarget(toolName, finalParams);

              const isError = s.state!=='DONE' || Boolean(s.tool_info?.error);
              const errText = s.tool_info?.error?.message || (s.tool_info?.error ? String(s.tool_info.error) : isError ? `Tool reported ${s.state}` : '');
              const outputText = extractToolOutput(s);
              const duration = typeof s.duration_seconds === 'number'
                ? s.duration_seconds
                : (saved.startTime ? (Date.now() - saved.startTime) / 1000 : undefined);
              const durLabel = duration !== undefined ? ` (${duration.toFixed(2)}s)` : '';
              const durationMs = duration !== undefined ? Math.round(duration * 1000) : 0;

              const summaryLabel = saved.toolSummary || p.toolSummary || toolName;
              await trace('tool.completed',{executionId:callId,name:toolName,parameters:finalParams,target:finalTarget,startedAt:saved.startedAt??null,completedAt:new Date().toISOString(),durationMs,status:isError?'failed':'completed',output:outputText,outputBytes:Buffer.byteLength(outputText,'utf8'),outputDigest:sha256Digest(outputText),error:isError?errText:null});
              if (efficiency.complete(callId, outputText, isError)) {
                await emitEvent({eventType:'harness.efficiency',stream:'system',level:'warn',message:'The same tool request returned unchanged output three times. Verify a concrete change or missing fact before repeating investigation.',payload:efficiency.snapshot()});
              }
              const doneMessage = `${summaryLabel} ${isError ? 'failed' : 'completed'}${durLabel}`;

              await deliverProgress({
                phase: 'run_activity',
                message: doneMessage.slice(0, 180),
                currentToolName: null,
                lastAssistantSnippet: lastAssistantSnippet || null,
                lastEventAt: new Date(),
              });

              // Canonical Paperclip tool execution completed event with full output audit
              const boundedOut = safeText(outputText, 65536);
              await emitEvent({
                eventType: 'tool.execution.completed',
                stream: 'system',
                level: isError ? 'warn' : 'info',
                message: `${summaryLabel} ${isError ? 'failed' : 'completed'}${durLabel}`.slice(0, 180),
                payload: {
                  schema: 'paperclip.tool.execution.v1',
                  executionId: callId,
                  transport: toolName === 'run_command' ? 'process' : 'builtin',
                  operation: mapToolOperation(toolName),
                  name: toolName === 'run_command' ? (finalTarget || 'Bash') : toolName,
                  target: finalTarget ? finalTarget.slice(0, 500) : null,
                  namespace: typeof finalParams.Cwd === 'string' ? finalParams.Cwd : null,
                  readOnly: isReadOnlyTool(toolName),
                  status: isError ? 'failed' : 'completed',
                  durationMs,
                  startedAt:saved.startedAt??null,
                  completedAt:new Date().toISOString(),
                  exitCode: isError ? 1 : 0,
                  progress: null,
                  output: boundedOut,
                  outputBytes: Buffer.byteLength(boundedOut, 'utf8'),
                  outputTruncated: outputText.length > 65536,
                  outputDigest: sha256Digest(boundedOut),
                  parameters: finalParams,
                  error: isError ? safeText(errText, 1000) : undefined,
                },
              });

              if(toolName === 'invoke_subagent') {
                await emitEvent({
                  eventType: 'delegation.completed',
                  stream: 'system',
                  level: isError ? 'warn' : 'info',
                  message: `Subagent ${isError ? 'failed' : 'completed'}${durLabel}`,
                  payload: {
                    schema: 'paperclip.delegation.v1',
                    delegationId: callId,
                    status: isError ? 'failed' : 'completed',
                    output: safeText(outputText, 2000),
                  },
                });
              } else if(toolName === 'search_web' || toolName === 'read_url_content') {
                await emitEvent({
                  eventType: 'research.completed',
                  stream: 'system',
                  level: isError ? 'warn' : 'info',
                  message: `Research ${isError ? 'failed' : 'completed'}${durLabel}`,
                  payload: {
                    schema: 'paperclip.research.v1',
                    researchId: callId,
                    status: isError ? 'failed' : 'completed',
                    output: safeText(outputText, 2000),
                  },
                });
              }

              await emitAcpx({
                type: 'acpx.tool_result',
                toolUseId: callId,
                toolName,
                name: toolName,
                content: safeText(outputText || (isError ? errText : 'completed'),65536),
                output: safeText(outputText || (isError ? errText : 'completed'),65536),
                outputTruncated: outputText.length>65536,
                isError,
              });
            }

            if(isObj(s.tool_info?.error) && looksLikePermissionDenial(String(s.tool_info.error.message??'')))permissionFailure=true;
          }

          if(isObj(s.usage)) {
            await emitEvent({
              eventType: 'usage.reported',
              stream: 'system',
              level: 'info',
              payload: {
                inputTokens: s.usage.input_tokens,
                outputTokens: s.usage.output_tokens,
                thinkingTokens: s.usage.thinking_tokens,
                totalTokens: s.usage.total_tokens,
              },
            });
            if(typeof s.usage.total_tokens === 'number') {
              await emitAcpx({
                type: 'acpx.status',
                text: `Context: ${s.usage.total_tokens} tokens`,
                used: s.usage.total_tokens,
              });
            }
          }
        }
      },
      onStderr: async (text) => { if(/quota|RESOURCE_EXHAUSTED/i.test(text)) quotaObservedAt ??= Date.now(); await trace('cli.stderr',{text}); if (looksLikePermissionDenial(text)) permissionFailure = true; },
    });

    providerStopped=true;
    await streamDelivery.flush();
    await publication.flush();
    if (workspaceLease) await workspaceLease.assertStopped();
    phase='finalization'; await trace('phase.started');
    const runtimeDurationMs=cliStartedAt===null?null:Math.round(performance.now()-cliStartedAt);
    const performancePayload={
      totalElapsedMs:Math.round(performance.now()-startedAt),
      preflightMs:spawnedAfterMs,
      cliDurationMs:runtimeDurationMs,
      phaseDurationsMs:{...phaseDurationsMs},
      eventQueue:proc.queueMetrics??null,
      efficiency:efficiency.snapshot(),
      callbackMetrics,operationDurationsMs,modelValidationCacheHit,streamDelivery:streamDelivery.snapshot(),journal:journal.snapshot(),
      publication:publication.snapshot(),
    };
    await trace('process.exit',{code:proc.code,signal:proc.signal,timedOut:proc.timedOut,reason:proc.reason,performance:performancePayload});
    await emitEvent({
      eventType:'harness.performance',stream:'system',level:'info',
      message:'Antigravity execution timing and event-queue diagnostics',
      payload:performancePayload,
    });
    for(const [callId,tool] of activeToolCalls) {
      await trace('tool.interrupted',{executionId:callId,name:tool.toolName,parameters:tool.parameters,target:tool.target,startedAt:tool.startedAt,interruptedAt:new Date().toISOString(),durationMs:Date.now()-tool.startTime});
      await emitEvent({eventType:'tool.execution.interrupted',stream:'system',level:'warn',message:`${tool.toolName} interrupted by process termination`,payload:{executionId:callId,status:'interrupted',durationMs:Date.now()-tool.startTime}});
    }
    activeToolCalls.clear();
    if(stopAccountMonitor) {await stopAccountMonitor(); stopAccountMonitor=null;}
    if(classifyError(proc)?.errorCode==='provider_quota' && currentAccountEmail) {
      const detail=`${proc.stderr||''} ${proc.reason||''} ${proc.final?.error||''}`;
      await markAccountQuotaExhausted(currentAccountEmail,null,parseQuotaResetDuration(detail),'provider_quota',
        cfg.accountPoolFile||undefined,cfg.model).catch(()=>{});
    }
    const classification = classifyError(proc);
    if (['provider_auth_error','provider_quota','provider_result_inconsistent'].includes(classification?.errorCode)) invalidateModelValidation();
    const fail=async(message,clearSession=false,extra={})=>{
      const finalId=typeof proc.final?.conversation_id==='string' && /^[\w-]{5,200}$/.test(proc.final.conversation_id) ? proc.final.conversation_id : null;
      const retainedId=finalId || observedConversationId;
      const keepSession=Boolean(retainedId && (proc.timedOut || proc.inactivityTimedOut || proc.aborted || extra.errorCode==='provider_result_inconsistent' || extra.errorFamily==='provider_quota' || ((accountChanged || previous?.resumeRequired) && extra.errorFamily==='session')));
      let retainedUsageTotals=canResume ? previous.usageTotals ?? null : null;
      if(keepSession && proc.final?.usage) {
        try {retainedUsageTotals=usageSince(proc.final.usage,retainedUsageTotals,{isResume:canResume}).usageTotals;}
        catch { /* A quota error may report zero counters; retain the last verified baseline. */ }
      }
      const retainedSession=keepSession ? {
        ...(canResume ? previous : {}),conversationId:retainedId,cwd,taskKey,workspaceId,
        model:cfg.model,account:currentAccountEmail,promptSignature,
        contextFingerprint:canResume ? previous.contextFingerprint : contextFingerprint,
        usageScope:'cumulative',resumeRequired:true,
        usageTotals:retainedUsageTotals,repeatHistory:efficiency.history(),
      } : null;
      await deliverProgress({
        phase: 'finalize',
        message: `Execution failed: ${message}`.slice(0, 180),
        currentToolName: null,
        lastAssistantSnippet: null,
        lastEventAt: new Date(),
      }).catch(()=>{});
      await emitEvent({
        eventType: 'harness.diagnostic',
        stream: 'stderr',
        level: 'error',
        message: safeText(message, 300),
        payload: {
          error: message,
          errorCode: extra.errorCode,
          errorFamily: extra.errorFamily,
        },
      }).catch(()=>{});
      await emitAcpx({
        type: 'acpx.error',
        message,
        code: extra.errorCode,
      }).catch(()=>{});
      await terminal('failed',{message,code:proc.code,...extra});
      return {exitCode:proc.code===0?1:proc.code??1,signal:proc.signal??null,
      timedOut:proc.timedOut,errorMessage:message,
      clearSession:keepSession ? false : clearSession || Boolean(canResume && (proc.code !== 0 || proc.final?.status !== 'SUCCESS')),
      ...(keepSession ? {sessionParams:retainedSession,sessionDisplayId:retainedId} : {}),
      provider:'antigravity',biller:'antigravity',billingType:'unknown',model:cfg.model,costStatus:'unpriced',
      ...extra,
      resultJson: {
        conversationContinuation: 'continue_conversation_v1',
        ...executionTimeoutResult(cfg),
        efficiency: efficiency.snapshot(),
        ...(extra.errorFamily ? { errorFamily: extra.errorFamily } : {}),
        ...(isObj(extra.resultJson) ? extra.resultJson : {}),
      }};
    };
    if(proc.timedOut)return await fail(`Antigravity timed out after ${cfg.timeoutSec}s`);
    if(proc.aborted)return await fail('Run canceled by Paperclip');
    if(proc.stdoutTruncated || proc.malformed)return await fail('Antigravity output exceeded limit or included invalid NDJSON');
    if(logTruncated)return await fail('Paperclip task transcript hit its configured size limit; execution is not fully auditable');
    if(classification) {
      return await fail(classification.message, classification.clearSession, {
        errorCode: classification.errorCode,
        errorFamily: classification.errorFamily,
        ...(classification.resultJson ? { resultJson: classification.resultJson } : {}),
      });
    }
    if(proc.reason) {
      const isPerm = /permission/i.test(proc.reason);
      const isInactivity = /inactivity/i.test(proc.reason);
      return await fail(`Antigravity execution failed: ${runtimePermissionError || proc.reason}`, false, {
        errorCode: isPerm ? 'permission_denied' : (isInactivity ? 'antigravity_output_inactivity_monitor' : 'adapter_failed'),
        errorFamily: isPerm ? 'permission' : (isInactivity ? 'execution' : undefined),
      });
    }
    if(permissionFailure || looksLikePermissionDenial(proc.stderr)) {
      return await fail('Antigravity denied a tool permission; run is not complete', false, {
        errorCode: 'permission_denied',
        errorFamily: 'permission',
      });
    }
    if(proc.code!==0) {
      if (classification) {
        let msg = classification.message;
        return await fail(msg, classification.clearSession, {
          errorCode: classification.errorCode,
          errorFamily: classification.errorFamily,
        });
      }
      const firstStderrLine = proc.stderr?.split('\n').map(l=>l.trim()).find(Boolean);
      const detail = firstStderrLine ? `: ${firstStderrLine.slice(0, 200)}` : '';
      return await fail(`Antigravity exited ${proc.code??'without status'}${detail}`);
    }
    if(!isObj(proc.final))return await fail('Antigravity did not provide a terminal result event');
    if(!['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING'].includes(proc.final.status) || typeof proc.final.response!=='string')return await fail('Invalid Antigravity final result payload');
    if(proc.final.status!=='SUCCESS'){
      if (classification) {
        let msg = classification.message;
        return await fail(msg, classification.clearSession, {
          errorCode: classification.errorCode,
          errorFamily: classification.errorFamily,
        });
      }
      const lost=/conversation.*(?:not found|invalid|expired)|unknown session/i.test(String(proc.final.error??''));
      return await fail(`Antigravity reported ${proc.final.status}; inspect the corresponding CLI run for details`,lost);
    }
    if(!proc.final.response.trim())return await fail('Antigravity reported success with an empty response');
    confirmModelValidation?.(cfg.model);
    if(cfg.executionMode==='planning' && (await worktreeStatus(cwd)).length) return await fail('Planning run modified the worktree; manual inspection required');

    let dirtyCount = 0;
    let dirtyFiles = [];
    try {
      dirtyFiles = await worktreeStatus(cwd);
      dirtyCount = dirtyFiles.length;
    } catch {}

    if (cfg.executionMode === 'implementation' && dirtyCount > 0) {
      await emitEvent({
        eventType: 'worktree.dirty_warning',
        stream: 'system',
        level: 'warn',
        message: `Worktree contains ${dirtyCount} uncommitted/untracked file(s) upon turn completion: ${dirtyFiles.slice(0, 5).join(', ')}${dirtyCount > 5 ? '...' : ''}`,
        payload: {
          dirtyFiles,
          dirtyCount,
          cwd,
          branch: workspace.branch,
        },
      });
    }

    const id=typeof proc.final.conversation_id==='string' && /^[\w-]{5,200}$/.test(proc.final.conversation_id)?proc.final.conversation_id:null;
    // AGY result counters are cumulative for a resumed conversation.
    const usageObj=usageSince(proc.final.usage,canResume?previous?.usageTotals:null,{isResume:canResume});
    const next=id?{conversationId:id,cwd,taskKey,workspaceId,model:cfg.model,account:currentAccountEmail,
      usageScope:'cumulative',usageTotals:usageObj.usageTotals,repeatHistory:efficiency.history(),
      promptSignature,contextFingerprint}:null;
    // Keep API-rate estimates distinct from subscription/provider invoices.
    const pricing = await timed('pricing', () => estimateCost(cfg.model, usageObj.usage));
    await emitAcpx({
      type: 'acpx.result',
      summary: safeText(proc.final.response, 300) || proc.final.status,
      inputTokens: usageObj.usage?.inputTokens,
      outputTokens: usageObj.usage?.outputTokens,
      cachedTokens: usageObj.usage?.cachedInputTokens,
      costUsd: pricing.costUsd,
      isError: false,
    });
    await emitAcpx({type:'acpx.status',text:pricing.costStatus === 'estimated'
      ? `Estimated Standard API-equivalent token cost: $${pricing.costUsdExact} (not a CLI charge)`
      : `Dollar cost unavailable: ${pricing.reason}`});
    await emitEvent({
      eventType: 'turn.completed',
      stream: 'system',
      level: 'info',
      message: `Turn completed (${proc.final.status})`,
      payload: {
        status: proc.final.status,
        durationSeconds: proc.final.duration_seconds,
        usage: usageObj.usage,
      },
    });
    await emitEvent({
      eventType: 'harness.exited',
      stream: 'system',
      level: 'info',
      message: 'Antigravity harness execution completed',
      payload: {
        conversationId: id,
        status: proc.final.status,
      },
    });
    await deliverProgress({
      phase: 'finalize',
      message: dirtyCount > 0 ? `Execution completed (${dirtyCount} uncommitted file(s))` : 'Execution completed',
      currentToolName: null,
      lastAssistantSnippet: safeText(proc.final.response, 200) || null,
      lastEventAt: new Date(),
    });

    await terminal('success',{conversationId:id});
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: pricing.provider ?? 'antigravity',
      biller: 'antigravity',
      billingType: 'unknown',
      model: cfg.model,
      costStatus: pricing.costStatus,
      costUsd: pricing.costUsd,
      costUsdExact: pricing.costUsdExact,
      pricingContext: pricing.pricingContext,
      pricingProvenance: pricing.pricingProvenance,
      usage:usageObj.usage||undefined,
      usageBasis:usageObj.usage?'per_run':null,
      sessionParams:next,
      sessionDisplayId: id,
      summary: safeText(proc.final.response, 1500),
      resultJson: {
        status: 'SUCCESS',
        conversationContinuation: 'continue_conversation_v1',
        ...executionTimeoutResult(cfg),
        response: safeText(proc.final.response, 20000),
        conversation_id: id,
        account: currentAccountEmail,
        pricingEstimate: pricing.estimate ?? null,
        pricingUnavailableReason: pricing.reason ?? null,
        efficiency: efficiency.snapshot(),
        promptStats:{mode:promptMode,bytes:Buffer.byteLength(prompt)},
        worktree: {
          branch: workspace.branch,
          dirtyCount,
          dirtyFiles: dirtyFiles.slice(0, 20),
        },
      },
    };
  } catch(err) {
    const message=errorText(err);
    await trace('run.exception',{message,phase,elapsedMs:Math.round(performance.now()-startedAt),phaseDurationsMs}).catch(()=>{});
    await deliverProgress({phase:'finalize',message:`Execution failed: ${message}`.slice(0,180),currentToolName:null,lastAssistantSnippet:null,lastEventAt:new Date()}).catch(()=>{});
    await emitEvent({eventType:'harness.diagnostic',stream:'stderr',level:'error',message:safeText(message,300),payload:{phase,error:message}}).catch(()=>{});
    await terminal('failed',{message,phase}).catch(()=>{});
    return {exitCode:1,signal:null,timedOut:false,errorMessage:errorText(err),
      ...(err.code==='workspace_busy'?{errorCode:'workspace_busy',errorMeta:{retryableBeforeDispatch:!spawned,requiresWorkspaceReconciliation:spawned}}:{}),
      ...(!spawned?{executionRecovery:{kind:'bootstrap',providerWorkStarted:false}}:{}),
      resultJson: {
        conversationContinuation: 'continue_conversation_v1',
        ...executionTimeoutResult(cfg),
      },
    };
  } finally {
    if(stopAccountMonitor) await stopAccountMonitor();
    const cleanupWarning=async (name,err)=>{
      const safe=sanitizeTelemetry({message:`${name} cleanup requires inspection: ${errorText(err)}`},ctx.authToken);
      await ctx.onLog('stderr',safe.message+'\n').catch(()=>{});
    };
    if (stagedSkills) await stagedSkills.cleanup().catch(err=>cleanupWarning('Skills',err));
    if (streamDelivery) await streamDelivery.close().catch(err=>cleanupWarning('Stream delivery',err));
    const sandboxAuthPath = cfg?.sandboxAuthJsonPath || ctx?.sandboxAuthJsonPath || ctx?.context?.sandboxAuthJsonPath;
    if (sandboxAuthPath) {
      try {
        await copyBackAntigravityAuth({
          readSandboxAuth: () => readFile(sandboxAuthPath),
          hostAuthPath: resolveAntigravityHostAuthPath(process.env),
          log: async (msg) => {
            await emitEvent({
              eventType: 'auth.copyback',
              stream: 'system',
              level: 'info',
              message: msg,
              payload: {},
            }).catch(() => {});
          },
          resolveCacheEntryPath: (accountId) =>
            resolveAntigravityAuthCacheEntryPath(process.env, accountId, ctx.agent?.companyId || 'default'),
          env: process.env,
        });
      } catch (err) { await cleanupWarning('Credential copy-back',err); }
    }
    if (workspaceLease) {
      try { await workspaceLease.release(!leaseDispatched || providerStopped); }
      catch (err) { await ctx.onLog('stderr', `Workspace lease cleanup requires inspection: ${errorText(err)}\n`).catch(()=>{}); }
    }
    if (journal) {
      await publication.flush().catch(err=>cleanupWarning('Telemetry delivery',err));
      await trace('run.performance.final',{totalElapsedMs:Math.round(performance.now()-startedAt),
        finalizationMs:phase==='finalization'?Math.round(performance.now()-lastPhaseAt):null,
        callbackMetrics,operationDurationsMs,modelValidationCacheHit,
        streamDelivery:streamDelivery?.snapshot()??null,journal:journal.snapshot(),publication:publication.snapshot()})
        .catch(err=>cleanupWarning('Final timing',err));
      await journal.close().catch(err=>cleanupWarning('Journal',err));
    }
  }
}
export async function execute(ctx) {
  const helpers=await import('@paperclipai/adapter-utils/server-utils');
  return executeWithHelpers(ctx,helpers);
}
