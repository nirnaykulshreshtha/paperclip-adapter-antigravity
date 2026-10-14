import { normalizeConfig } from '../lib/config.js';
import { validateWorkspace } from '../lib/workspace.js';
import { resolveAssignedWorkspace } from '../lib/assigned-workspace.js';
import { runAgy } from '../lib/process.js';
import { resolveAgyCommand } from '../lib/models.js';
import { probeWithCache } from '../lib/probe.js';
import { evaluateAntigravityCredentialReadiness } from '../lib/credential-readiness.js';
import {
  buildAdapterTestTargetCheck,
  buildAntigravityLoginRequiredHint,
  classifyThrownErrorClass,
  logAntigravityProbeDiagnostic,
} from '../lib/probe-diagnostics.js';

export async function testEnvironment(ctx, { probe = probeWithCache, evaluateReadiness = evaluateAntigravityCredentialReadiness } = {}) {
  const checks=[]; const add=(code,level,message,hint)=>checks.push({code,level,message,hint});
  checks.push(buildAdapterTestTargetCheck({
    targetIsRemote: ctx?.executionTarget && ctx.executionTarget.kind !== 'local',
    environmentName: ctx?.environmentName,
  }));
  // Paperclip's initial onboarding often probes the adapter BEFORE it exposes
  // per-agent working-directory fields. Do not report an authentication error
  // or claim readiness: warn about the missing config while allowing the UI
  // to continue setup. Real execute() remains strictly fail-closed.
  const raw = ctx?.config && typeof ctx.config === 'object' ? ctx.config : (ctx?.adapterConfig ?? ctx?.agent?.adapterConfig ?? {});
  const unconfigured = !raw.cwd && !raw.allowedWorkspaceRoot;
  let cfg;
  if (unconfigured) {
    cfg = {command: await resolveAgyCommand({config:raw}), cwd:process.cwd(), model: typeof raw.model === 'string' ? raw.model.trim() : '', probeAuthentication: raw.probeAuthentication !== false, probeTimeoutSec: raw.probeTimeoutSec || 35};
    add('workspace','warn','Workspace is not configured yet. Finish onboarding, then set absolute cwd and allowedWorkspaceRoot in the agent configuration. Agent execution will fail until configured.');
  } else {
    try {cfg=normalizeConfig(raw);add('config','info','Configuration parses correctly');}
    catch(err){add('config','error',err.message);return {adapterType:'antigravity_local',status:'fail',checks,testedAt:new Date().toISOString()};}
  }
  if(ctx?.executionTarget && ctx.executionTarget.kind && ctx.executionTarget.kind!=='local') {
    add('target','error','Only local execution targets are supported. Remote targets are deliberately disabled');
  }
  if (!unconfigured) {
    try {
      if (cfg.workspaceMode === 'paperclip') {
        const candidate = ctx?.context?.paperclipWorkspace;
        if (!candidate?.cwd) add('workspace','warn','Paperclip will assign the issue worktree when a task runs; no task workspace exists during configuration test.');
        else {const ws=await resolveAssignedWorkspace(ctx,cfg);add('workspace','info',`Paperclip issue worktree validated (${ws.branch})`);}
      } else {const ws=await validateWorkspace(cfg);add('workspace','info',`Fixed pilot worktree validated (${ws.branch})`);}
    }
    catch(err){add('workspace','error',err.message);}
  }
  try {
    const res=await runAgy({command:cfg.command,args:['--version'],cwd: cfg.workspaceMode === 'paperclip' ? cfg.repositoryRoot : cfg.cwd,
      env:process.env,prompt:'',timeoutMs:12000,graceMs:2000,maxBytes:100000,
      onEvent:()=>{},onStderr:()=>{}});
    // runAgy sends a prompt to stdin. `--version` should terminate before consuming it.
    if(res.code===0)add('cli','info','Antigravity executable launches successfully');
    else add('cli','error',`Antigravity executable returned ${res.code}: ${res.reason||res.stderr.slice(0,200)}`);
  } catch(err){add('cli','error',err.message);}
  // Probe only the selected/default model, in a fresh empty temporary directory.
  // Never multiply quota use by probing all the discovered models.
  if (cfg.probeAuthentication) {
    if (!cfg.model || cfg.model === 'default') {
      add('auth','warn','No Antigravity model selected. Choose a live account model before running the agent; no model inference probe was executed.');
    } else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(cfg.model)) {
      add('auth','error','Model identifier is invalid. Select a model from the live account model list.');
    } else if (!Number.isInteger(Number(cfg.probeTimeoutSec)) || Number(cfg.probeTimeoutSec)<10 || Number(cfg.probeTimeoutSec)>120) {
      add('auth','error','probeTimeoutSec must be between 10 and 120 seconds');
    } else {
      try {
        const readiness = await evaluateReadiness({
          companyId: ctx?.agent?.companyId || ctx?.companyId || 'default',
          configuredApiKey: raw.apiKey || process.env.ANTIGRAVITY_API_KEY || process.env.GEMINI_API_KEY,
          accountId: raw.accountId || ctx?.agent?.adapterConfig?.accountId,
          sandboxAuthJson: raw.sandboxAuthJson,
          env: process.env,
        }).catch(() => null);
        if (readiness?.ready) {
          add('credential_readiness', 'info', `Antigravity credentials ready (${readiness.authMode} mode via ${readiness.source}).`);
        }

        const probeResult = await probe({command:cfg.command,model:cfg.model,probeTimeoutSec:Number(cfg.probeTimeoutSec),probeIdentity:readiness?.account ? JSON.stringify([ctx?.agent?.companyId || ctx?.companyId || 'default',readiness.source,readiness.account]) : null});
        if (probeResult.ok) {
          const u = probeResult.tokens ?? {};
          const usage = Number.isInteger(u.totalTokens)
            ? `${u.totalTokens} total tokens`
            : Number.isInteger(u.inputTokens) && Number.isInteger(u.outputTokens)
              ? `${u.inputTokens} input + ${u.outputTokens} output tokens`
              : 'token count unavailable';
          add('hello_probe_passed','info',`Authenticated Antigravity model responded successfully (${probeResult.cached?'cached result; ':''}${usage}).`);
        } else {
          const isAuthError = /(?:authentication|unauthenticated|unauthorized|not logged in|credentials)/i.test(probeResult.reason || '');
          add(isAuthError ? 'adapter_auth_missing' : 'auth','error',`Minimal model probe failed: ${probeResult.reason}`, isAuthError ? buildAntigravityLoginRequiredHint() : undefined);
        }
      } catch (err) {
        const errorClass = classifyThrownErrorClass(err);
        logAntigravityProbeDiagnostic('Minimal model probe encountered an unexpected error', 'probe_exception', { errorClass });
        add('adapter_auth_missing','error','Minimal model probe encountered an unexpected error; inspect local CLI authentication.', buildAntigravityLoginRequiredHint());
      }
    }
  } else {
    add('auth','warn','Minimal authenticated model probe disabled in configuration; CLI launch does not verify credentials.');
  }
  add('permissions','warn','Terminal sandbox and worktree guards are not full OS isolation; do not use live production credentials or main checkout.');
  const status=checks.some(c=>c.level==='error')?'fail':'warn';
  return {adapterType:'antigravity_local',status,checks,testedAt:new Date().toISOString()};
}
