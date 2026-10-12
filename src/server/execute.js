import { realpath, access, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeConfig } from '../lib/config.js';
import { validateWorkspace, worktreeStatus, checkBranchFreshness, readInstructions } from '../lib/workspace.js';
import { resolveAssignedWorkspace } from '../lib/assigned-workspace.js';
import { stageAssignedSkills } from '../lib/skills.js';
import { runAgy } from '../lib/process.js';
import { errorText, looksLikePermissionDenial, sessionIdFrom, usageOf, isObj } from '../lib/result.js';
import { usageSince } from '../lib/usage.js';
import { discoverAgyModels } from '../lib/models.js';
import { detectActiveAccount, detectHeadlessKeychainAccount } from '../lib/account.js';
import { readObservedStatus } from '../lib/statusline.js';
import { loadAccountPool, syncKeychainToPool, markAccountQuotaExhausted, parseQuotaResetDuration } from '../lib/account-pool.js';

const safeText=(v,max=5000)=>typeof v==='string'?v.slice(0,max):'';
const maybeStr=(v)=>typeof v==='string'?v:'';

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
  if (s.state === 'DONE') {
    const dur = typeof s.duration_seconds === 'number' ? ` (${s.duration_seconds.toFixed(2)}s)` : '';
    if (s.tool_info?.error) {
      const errMsg = s.tool_info.error?.message || String(s.tool_info.error);
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

/** Build a bounded prompt without duplicating arbitrary private server context. */
export function buildPrompt(ctx, cfg, instr, helpers, skillIndex = '', options = {}) {
  const context = isObj(ctx.context)?ctx.context:{};
  const templateData={
    agentId:ctx.agent.id,companyId:ctx.agent.companyId,runId:ctx.runId,
    agent:{id:ctx.agent.id,name:ctx.agent.name},
    company:{id:ctx.agent.companyId},
    run:{id:ctx.runId},context,
    taskId:context.taskId??context.issueId??'', taskTitle:context.taskTitle??'',
  };
  const main = cfg.promptTemplate || helpers.DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE || 'You are agent {{agent.id}} ({{agent.name}}).';
  const sections=[helpers.renderTemplate(main,templateData)];
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
    ['Upstream blockers / dependencies', Array.isArray(context.dependencies) ? context.dependencies.join(', ') : context.dependencies],
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
    `You are part of an integrated multi-agent engineering squad:\n` +
    `- Delivery Lead coordinates assignments, breaks down epics, and unblocks agents.\n` +
    `- Technical Architect defines system design and interface contracts.\n` +
    `- Specialist agents (Backend, Frontend, Database, Integrations, QA, Release) own their respective domains.\n` +
    `- Shared deliverables: When completing work or encountering blockers, post structured comments in Paperclip detailing changed files, new endpoints/schemas, and test verification results so other squad members stay in sync.\n` +
    `- Cross-domain delegation: When you need work from another specialist domain, create or request child tasks in Paperclip rather than implementing outside your role mandate.`);

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
export async function executeWithHelpers(ctx, helpers, { discoverModels = discoverAgyModels } = {}) {
  let spawned=false;
  let stagedSkills=null;
  const emitEvent=event=>ctx.onEvent?.(sanitizeTelemetry(event,ctx.authToken));
  try {
    if (typeof ctx.authToken !== 'string' || !ctx.authToken.trim()) {
      throw new Error('Antigravity execution requires a host-issued run-scoped Paperclip API token');
    }
    const cfg=normalizeConfig(ctx.config);
    if (ctx.executionTarget?.kind && ctx.executionTarget.kind !== 'local') throw new Error('Only local execution targets are permitted');
    const taskKey=maybeStr(ctx.runtime?.taskKey)||maybeStr(ctx.context?.taskKey)||maybeStr(ctx.context?.taskId)||maybeStr(ctx.context?.issueId);
    const hasAssignedTask=Boolean(taskKey);

    // If Paperclip wakes the agent on a heartbeat or on-demand without an assigned issue/task,
    // handle it cleanly as an idle heartbeat check instead of crashing on worktree resolution.
    if (cfg.workspaceMode === 'paperclip' && !hasAssignedTask) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: 'antigravity',
        biller: 'antigravity',
        billingType: 'external_cli_unverified',
        model: cfg.model,
        costStatus: 'unpriced',
        summary: `Agent ${ctx.agent?.name || 'idle'}: heartbeat completed. No active task assigned.`,
        resultJson: {
          status: 'SUCCESS',
          conversationContinuation: 'continue_conversation_v1',
          response: 'Heartbeat idle check completed; no active task assigned.',
          conversation_id: null,
        },
      };
    }
    const workspace = cfg.workspaceMode === 'paperclip'
      ? await resolveAssignedWorkspace(ctx, cfg)
      : await validateWorkspace(cfg);
    const {cwd} = workspace;
    if (cfg.workspaceMode === 'paperclip' && cfg.executionMode === 'implementation') {
      const issueId = maybeStr(ctx.context?.issueId) || maybeStr(ctx.context?.taskId);
      if (!issueId || (!cfg.approvedIssueIds.includes(issueId) && !cfg.approvedProjectIds.includes(workspace.projectId))) {
        throw new Error('Implementation blocked: current issue has no explicit issue or isolated project implementation authorization');
      }
    }
    if(cfg.executionMode==='planning' && (await worktreeStatus(cwd)).length) {
      throw new Error('Planning requires a clean worktree (except the opt-in sentinel)');
    }
    // Preflight authorization must run BEFORE potentially slow external CLI discovery.
    // Unit tests inject deterministic discovery without changing production behavior.
    if (cfg.validateSelectedModelOnRun) {
      const available = await discoverModels({ config: cfg });
      if (!Array.isArray(available) || !available.some(entry => entry?.id === cfg.model)) {
        throw new Error(`Model ${cfg.model} is no longer available for the AGY account; refresh Paperclip's model list.`);
      }
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

    const prompt=buildPrompt(ctx,cfg,instructions,helpers,stagedSkills.index, { graphifyAvailable: hasGraphify });
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
    const observed = await readObservedStatus().catch(()=>null);
    const activeAccount=await detectActiveAccount().catch(()=>null);
    const currentAccountEmail=activeAccount?.email||null;
    if(currentAccountEmail) {
      const file=cfg.accountPoolFile||undefined;
      await syncKeychainToPool(await loadAccountPool(file),file);
    }
    const headlessKeychain=await detectHeadlessKeychainAccount().catch(()=>null);
    if(observed?.email && headlessKeychain?.email && observed.email!==headlessKeychain.email)
      throw new Error('AGY terminal account and headless credential account disagree. Reauthenticate and refresh AGY status before executing.');
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
      message:'AGY account changed; starting a fresh session',
      payload:{previousAccount,currentAccount:currentAccountEmail}});
    const modelChanged=Boolean(previous?.model && previous.model!==cfg.model);
    const previousAccountNowUnknown=Boolean(previousAccount && !currentAccountEmail);
    const forceFresh=Boolean(ctx.context?.forceFreshSession || accountChanged || modelChanged || previousAccountNowUnknown);
    const canResume = Boolean(!forceFresh && oldId && previousCwd === cwd &&
      (!previous.taskKey || previous.taskKey === taskKey) &&
      (!previous.workspaceId || previous.workspaceId === workspaceId) &&
      (!previous.model || previous.model===cfg.model) &&
      (!previous.account || previous.account===currentAccountEmail));
    if (oldId && !canResume && !forceFresh) {
      throw new Error('Stored conversation belongs to another workspace or task; reset the Paperclip session before retrying');
    }
    const buildArgs = (modelToUse, resumeConvId) => {
      const a = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox',
        `--mode=${cfg.executionMode === 'planning' ? 'plan' : 'default'}`, '--print-timeout', `${cfg.timeoutSec}s`];
      a.push('--model', modelToUse);
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
      PAPERCLIP_TASK_ID:maybeStr(ctx.context?.taskId)||maybeStr(ctx.context?.issueId),
      PAPERCLIP_WAKE_REASON:maybeStr(ctx.context?.wakeReason),
      PAPERCLIP_WAKE_COMMENT_ID:maybeStr(ctx.context?.wakeCommentId),
      PAPERCLIP_APPROVAL_ID:maybeStr(ctx.context?.approvalId),
      PAPERCLIP_APPROVAL_STATUS:maybeStr(ctx.context?.approvalStatus),
    };
    for(const [k,v] of Object.entries(bindings)) if(v)env[k]=v;
    await ctx.onMeta?.({adapterType:'antigravity_local',command:cfg.command,cwd,
      commandArgs:args,workspaceId,commandNotes:['Prompt sent via stdin; secrets omitted','Paperclip-assigned issue worktree verified','Sandbox enabled; permissions governed by agy user settings']});
    await ctx.onCancellationReady?.();
    if(ctx.signal?.aborted)throw new Error('Canceled before dispatch');
    ctx.onDispatch?.();
    let permissionFailure=false;
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
      if(limited) await ctx.onLog(stream,limited);
    };
    const emitAcpx = async (payload) => {
      await log('stdout', `${JSON.stringify(payload)}\n`);
    };

    const classifyError = (p) => {
      const combined = `${p?.stderr || ''}\n${p?.reason || ''}\n${p?.final?.error || ''}`;
      const isAuth = /(?:not\s+logged\s+into|not\s+logged\s+in|login\s+required|run\s+`?agy\s+auth(?:\s+login)?`?\s+first|please\s+authenticate|token\s+source|unauthenticated|unauthorized|invalid\s+credentials|api[_ ]?key\s+(?:required|missing|invalid)|auth(?:entication)?\s+required)/i.test(combined);
      const isQuota = !isAuth && (/(?:RESOURCE_EXHAUSTED|quota|rate[-\s]?limit|token\s*limit|too\s+many\s+requests|\b429\b|billing\s+details|exceeded.*quota|out\s+of\s+quota|out\s+of\s+tokens)/i.test(combined) ||
                      (p?.code === 3 && /quota|rate\s*limit|limit|exhaust/i.test(combined)));
      const isSessionLost = /conversation.*(?:not\s+found|invalid|expired)|unknown\s+session|cannot\s+resume|failed\s+to\s+resume/i.test(combined);
      const isTurnLimit = p?.code === 53 || /(?:turn_limit|max_turns)/i.test(combined);

      if (isTurnLimit) {
        return {
          errorCode: 'agent_turn_limit_reached',
          errorFamily: 'execution',
          message: 'Antigravity reached maximum conversation turn limit. Task should be broken down into smaller sub-tasks.',
          clearSession: false,
        };
      }
      if (isQuota) {
        return {
          errorCode: 'provider_quota',
          errorFamily: 'provider_quota',
          message: 'Antigravity token limit / quota reached. Verify Google account quota or switch accounts.',
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

    let lastAssistantSnippet = '';
    let toolStepCounter = 0;
    const activeToolCalls = new Map();

    let resumeConvId = canResume ? oldId : null;
    const runArgs=buildArgs(cfg.model,resumeConvId);
    let proc = null;
    // The CLI owns account selection. Never re-run side-effectful turns under a different account.
      proc = await runAgy({
        command: cfg.command,
        args: runArgs,
        cwd,
        env,
        prompt,
      timeoutMs:cfg.timeoutSec*1000,graceMs:cfg.graceSec*1000,maxBytes:cfg.maxOutputBytes,
      signal:ctx.signal,
      onSpawn:async(meta)=>{
        spawned=true;
        await ctx.onSpawn?.(meta);
        await ctx.onRuntimeProgress?.({
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
        if(evt.event==='init') {
          if (evt.init?.permission_mode==='always-proceed') {
            // Explicit operator opt-in for this verified project, never fixed/pilot mode.
            const approvedRuntime = cfg.allowUnattendedRuntime && cfg.executionMode === 'implementation' &&
              cfg.workspaceMode === 'paperclip' && cfg.approvedProjectIds.includes(workspace.projectId);
            if (!approvedRuntime) return false;
          }
          const convId = typeof evt.conversation_id === 'string' ? evt.conversation_id : null;
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
          await ctx.onRuntimeProgress?.({
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
            await emitAcpx({
              type: 'acpx.text_delta',
              text: s.text_delta,
              channel: 'output',
            });
            lastAssistantSnippet = (lastAssistantSnippet + s.text_delta).slice(-200).trim();
            await ctx.onRuntimeProgress?.({
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
              activeToolCalls.set(callId, {
                toolName,
                parameters: p,
                target,
                toolAction: p.toolAction,
                toolSummary: p.toolSummary,
                startTime: Date.now(),
              });

              const activeDesc = p.toolAction
                ? `${p.toolAction}${target ? `: ${target.slice(0, 120)}` : ''}`
                : (target ? `Running ${toolName}: ${target.slice(0, 120)}` : `Using ${toolName}`);

              await ctx.onRuntimeProgress?.({
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
            } else if(s.state==='DONE') {
              const saved = activeToolCalls.get(callId) || {};
              activeToolCalls.delete(callId);
              const finalParams = Object.keys(p).length > 0 ? p : (saved.parameters || {});
              const finalTarget = target || saved.target || extractToolTarget(toolName, finalParams);

              const isError = Boolean(s.tool_info?.error);
              const errText = s.tool_info?.error?.message || (isError ? String(s.tool_info.error) : '');
              const outputText = extractToolOutput(s);
              const duration = typeof s.duration_seconds === 'number'
                ? s.duration_seconds
                : (saved.startTime ? (Date.now() - saved.startTime) / 1000 : undefined);
              const durLabel = duration !== undefined ? ` (${duration.toFixed(2)}s)` : '';
              const durationMs = duration !== undefined ? Math.round(duration * 1000) : 0;

              const summaryLabel = saved.toolSummary || p.toolSummary || toolName;
              const doneMessage = `${summaryLabel} ${isError ? 'failed' : 'completed'}${durLabel}`;

              await ctx.onRuntimeProgress?.({
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
      onStderr: async (text) => { if (looksLikePermissionDenial(text)) permissionFailure = true; },
    });

    if(classifyError(proc)?.errorCode==='provider_quota' && currentAccountEmail) {
      const detail=`${proc.stderr||''} ${proc.reason||''} ${proc.final?.error||''}`;
      await markAccountQuotaExhausted(currentAccountEmail,null,parseQuotaResetDuration(detail),'provider_quota',
        cfg.accountPoolFile||undefined,cfg.model).catch(()=>{});
    }
  const classification = classifyError(proc);
    const fail=(message,clearSession=false,extra={})=>{
      ctx.onRuntimeProgress?.({
        phase: 'finalize',
        message: `Execution failed: ${message}`.slice(0, 180),
        currentToolName: null,
        lastAssistantSnippet: null,
        lastEventAt: new Date(),
      })?.catch(()=>{});
      emitEvent({
        eventType: 'harness.diagnostic',
        stream: 'stderr',
        level: 'error',
        message: safeText(message, 300),
        payload: {
          error: message,
          errorCode: extra.errorCode,
          errorFamily: extra.errorFamily,
        },
      })?.catch(()=>{});
      emitAcpx({
        type: 'acpx.error',
        message,
        code: extra.errorCode,
      })?.catch(()=>{});
      return {exitCode:proc.code===0?1:proc.code??1,signal:proc.signal??null,
      timedOut:proc.timedOut,errorMessage:message,
      clearSession:clearSession || Boolean(canResume && (proc.code !== 0 || proc.final?.status !== 'SUCCESS')),
      provider:'antigravity',biller:'antigravity',billingType:'external_cli_unverified',model:cfg.model,costStatus:'unpriced',
      ...extra,
      resultJson: {
        conversationContinuation: 'continue_conversation_v1',
        ...(extra.errorFamily ? { errorFamily: extra.errorFamily } : {}),
        ...(isObj(extra.resultJson) ? extra.resultJson : {}),
      }};
    };
    if(proc.timedOut)return fail(`Antigravity timed out after ${cfg.timeoutSec}s`);
    if(proc.aborted)return fail('Run canceled by Paperclip');
    if(proc.stdoutTruncated || proc.malformed)return fail('Antigravity output exceeded limit or included invalid NDJSON');
    if(logTruncated)return fail('Paperclip task transcript hit its configured size limit; execution is not fully auditable');
    if(proc.reason)return fail(`Antigravity execution failed: ${proc.reason}`);
    if(permissionFailure || looksLikePermissionDenial(proc.stderr))return fail('Antigravity denied a tool permission; run is not complete');
    if(proc.code!==0) {
      if (classification) {
        let msg = classification.message;
        return fail(msg, classification.clearSession, {
          errorCode: classification.errorCode,
          errorFamily: classification.errorFamily,
        });
      }
      const firstStderrLine = proc.stderr?.split('\n').map(l=>l.trim()).find(Boolean);
      const detail = firstStderrLine ? `: ${firstStderrLine.slice(0, 200)}` : '';
      return fail(`Antigravity exited ${proc.code??'without status'}${detail}`);
    }
    if(!isObj(proc.final))return fail('Antigravity did not provide a terminal result event');
    if(!['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING'].includes(proc.final.status) || typeof proc.final.response!=='string')return fail('Invalid Antigravity final result payload');
    if(proc.final.status!=='SUCCESS'){
      if (classification) {
        let msg = classification.message;
        return fail(msg, classification.clearSession, {
          errorCode: classification.errorCode,
          errorFamily: classification.errorFamily,
        });
      }
      const lost=/conversation.*(?:not found|invalid|expired)|unknown session/i.test(String(proc.final.error??''));
      return fail(`Antigravity reported ${proc.final.status}; inspect the corresponding CLI run for details`,lost);
    }
    if(!proc.final.response.trim())return fail('Antigravity reported success with an empty response');
    const afterAccount=await detectActiveAccount().catch(()=>null);
    if(currentAccountEmail && afterAccount?.email && currentAccountEmail!==afterAccount.email)
      return fail('AGY account changed during execution; session must not be reused',true,{errorFamily:'auth'});
    if(cfg.executionMode==='planning' && (await worktreeStatus(cwd)).length) return fail('Planning run modified the worktree; manual inspection required');

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
      usageScope:'cumulative',usageTotals:usageObj.usageTotals}:null;
    // Subscription CLI usage is not an authenticated metered API invoice.
    const hasReportedCost=false;
    await emitAcpx({
      type: 'acpx.result',
      summary: safeText(proc.final.response, 300) || proc.final.status,
      inputTokens: usageObj.usage?.inputTokens,
      outputTokens: usageObj.usage?.outputTokens,
      cachedTokens: usageObj.usage?.cachedInputTokens,
      costUsd: undefined,
      isError: false,
    });
    await emitAcpx({type:'acpx.status',text:'Dollar cost unavailable: AGY CLI token totals are not billing records'});
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
    await ctx.onRuntimeProgress?.({
      phase: 'finalize',
      message: dirtyCount > 0 ? `Execution completed (${dirtyCount} uncommitted file(s))` : 'Execution completed',
      currentToolName: null,
      lastAssistantSnippet: safeText(proc.final.response, 200) || null,
      lastEventAt: new Date(),
    });

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: 'antigravity',
      biller: 'antigravity',
      billingType: 'external_cli_unverified',
      model: cfg.model,
      costStatus: 'unpriced',
      usage:usageObj.usage||undefined,
      usageBasis:usageObj.usageBasis,
      sessionParams:next,
      sessionDisplayId: id,
      summary: safeText(proc.final.response, 1500),
      resultJson: {
        status: 'SUCCESS',
        conversationContinuation: 'continue_conversation_v1',
        response: safeText(proc.final.response, 20000),
        conversation_id: id,
        account: currentAccountEmail,
        worktree: {
          branch: workspace.branch,
          dirtyCount,
          dirtyFiles: dirtyFiles.slice(0, 20),
        },
      },
    };
  } catch(err) {
    return {exitCode:1,signal:null,timedOut:false,errorMessage:errorText(err),
      ...(!spawned?{executionRecovery:{kind:'bootstrap',providerWorkStarted:false}}:{}),
      resultJson: {
        conversationContinuation: 'continue_conversation_v1',
      },
    };
  } finally {
    if (stagedSkills) await stagedSkills.cleanup();
  }
}
export async function execute(ctx) {
  const helpers=await import('@paperclipai/adapter-utils/server-utils');
  return executeWithHelpers(ctx,helpers);
}
