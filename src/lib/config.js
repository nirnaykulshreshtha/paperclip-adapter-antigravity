import path from 'node:path';
const text = (v, fallback = '') => typeof v === 'string' && v.trim() ? v.trim() : fallback;
const int = (v, fallback, min, max) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Integer must be in range ${min}–${max}`);
  return n;
};
export function normalizeConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Adapter config must be an object');
  const mode = text(raw.executionMode, 'planning');
  if (!['planning', 'implementation'].includes(mode)) throw new Error('executionMode must be planning or implementation');
  if (raw.sandbox === false) throw new Error('sandbox=false is prohibited by this adapter');
  if (raw.dangerouslySkipPermissions === true || raw.skipPermissions === true || raw.extraArgs) {
    throw new Error('Unrestricted permissions and extraArgs are not supported');
  }
  if (mode === 'implementation' && raw.enableImplementation !== true) {
    throw new Error('Implementation mode requires enableImplementation=true');
  }
  const command = text(raw.command, 'agy');
  if (/\s|[;&|`$><\r\n]/.test(command)) throw new Error('command must be a single executable name or absolute path');
  const workspaceMode = text(raw.workspaceMode, 'fixed');
  if (!['fixed', 'paperclip'].includes(workspaceMode)) throw new Error('workspaceMode must be fixed or paperclip');
  const repositoryRoot = text(raw.repositoryRoot);
  const cwd = text(raw.cwd);
  const root = text(raw.allowedWorkspaceRoot);
  if (!path.isAbsolute(root) || (workspaceMode === 'fixed' && !path.isAbsolute(cwd)) ||
      (workspaceMode === 'paperclip' && !path.isAbsolute(repositoryRoot))) {
    throw new Error('Fixed mode needs absolute cwd and allowedWorkspaceRoot; paperclip mode needs absolute repositoryRoot and allowedWorkspaceRoot');
  }
  const model = text(raw.model);
  if (!model || model === 'default' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model)) {
    throw new Error('Select an explicit Antigravity model from the live account model list');
  }
  const effort = text(raw.effort);
  if (effort && !['low', 'medium', 'high'].includes(effort)) throw new Error('effort must be low/medium/high');
  const cliAgent = text(raw.cliAgent);
  if (cliAgent && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(cliAgent)) throw new Error('Invalid cliAgent');
  const instr = text(raw.instructionsFilePath);
  if (instr && !path.isAbsolute(instr)) throw new Error('instructionsFilePath must be absolute');
  const approvalInput=raw.approvedIssueIds;
  const approvedIssueIds=Array.isArray(approvalInput) ? approvalInput : (typeof approvalInput === 'string' ? approvalInput.split(',') : []);
  if (approvedIssueIds.length > 50 || approvedIssueIds.some(x => typeof x !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(x.trim()))) {
    throw new Error('approvedIssueIds must contain at most 50 valid issue ID strings');
  }
  const approvedProjectIds = raw.approvedProjectIds ?? [];
  if (!Array.isArray(approvedProjectIds) || approvedProjectIds.length > 10 ||
      approvedProjectIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('approvedProjectIds must contain at most 10 valid project UUIDs');
  }
  if (approvedProjectIds.length && workspaceMode !== 'paperclip') {
    throw new Error('Project implementation authorization requires Paperclip isolated workspaces');
  }
  const promptPolicy = text(raw.promptPolicy, 'compact_resume');
  const timeoutPolicy = text(raw.timeoutPolicy, 'completion');
  if(!['completion','bounded'].includes(timeoutPolicy)) throw new Error('timeoutPolicy must be completion or bounded');
  const configuredTimeoutSec=int(raw.timeoutSec,0,0,3600);
  if(timeoutPolicy==='bounded' && configuredTimeoutSec===0) throw new Error('Bounded execution requires a positive timeoutSec');
  if (!['compact_resume', 'full_every_turn'].includes(promptPolicy)) {
    throw new Error('promptPolicy must be compact_resume or full_every_turn');
  }
  const accountPoolFile = text(raw.accountPoolFile);
  if (accountPoolFile && !path.isAbsolute(accountPoolFile)) {
    throw new Error('accountPoolFile must be an absolute path');
  }
  const sandboxAuthJsonPath = text(raw.sandboxAuthJsonPath);
  if (sandboxAuthJsonPath && !path.isAbsolute(sandboxAuthJsonPath)) {
    throw new Error('sandboxAuthJsonPath must be an absolute path');
  }
  return {
    approvedProjectIds: [...new Set(approvedProjectIds)],
    allowUnattendedRuntime: raw.allowUnattendedRuntime !== false,
    approvedIssueIds: [...new Set(approvedIssueIds.map(x=>x.trim()))],
    command, cwd, allowedWorkspaceRoot: root, repositoryRoot, workspaceMode, executionMode: mode,
    enableImplementation: raw.enableImplementation === true,
    sandbox: true, model, effort, cliAgent,
    // AGY owns authentication; never auto-rotate credentials to work around quotas.
    enableAccountRotation: false,
    validateSelectedModelOnRun: raw.validateSelectedModelOnRun !== false,
    accountPoolFile: accountPoolFile || null,
    timeoutPolicy,
    timeoutSec: timeoutPolicy==='bounded' ? configuredTimeoutSec : 0,
    outputInactivityTimeoutMs: raw.outputInactivityTimeoutMs === null ? null : raw.outputInactivityTimeoutMs === undefined ? undefined : int(raw.outputInactivityTimeoutMs, undefined, 1, 86400000),
    probeAuthentication: raw.probeAuthentication !== false,
    probeTimeoutSec: int(raw.probeTimeoutSec, 35, 10, 120),
    graceSec: int(raw.graceSec, 10, 2, 60),
    maxOutputBytes: int(raw.maxOutputBytes, 3_000_000, 8192, 16_000_000),
    maxPromptBytes: int(raw.maxPromptBytes, 100_000, 1024, 500_000),
    promptPolicy,
    investigationBudget: int(raw.investigationBudget, 12, 4, 100),
    promptTemplate: typeof raw.promptTemplate === 'string' ? raw.promptTemplate : '',
    instructionsFilePath: instr,
    sandboxAuthJsonPath: sandboxAuthJsonPath || null,
  };
}
export const configSchema = {
  fields: [
    { key: 'model', label: 'Antigravity model', type: 'combobox', required: true, options: [], hint: 'Choose a live model returned by Refresh models (agy models); model IDs are not hard-coded' },
    { key: 'command', label: 'Antigravity executable', type: 'text', default: 'agy', hint: 'Absolute path recommended (e.g. /Users/…/.local/bin/agy)' },
    { key: 'workspaceMode', label: 'Workspace mode', type: 'select', default: 'fixed', options: [{label:'Paperclip isolated issue workspace',value:'paperclip'}, {label:'Legacy fixed worktree',value:'fixed'}] },
    { key: 'cwd', label: 'Legacy fixed worktree (not used in Paperclip mode)', type: 'text' },
    { key: 'repositoryRoot', label: 'Trusted primary Git checkout (Paperclip mode)', type: 'text', hint: 'Absolute path to YourClientDesk main checkout; never executed from directly' },
    { key: 'allowedWorkspaceRoot', label: 'Authorized issue worktrees parent directory', type: 'text', required: true },
    { key: 'executionMode', label: 'Execution mode', type: 'select', default: 'planning', options: [{ label: 'Planning (pilot)', value: 'planning' }, { label: 'Implementation (opt-in)', value: 'implementation' }] },
    { key: 'enableImplementation', label: 'Authorize implementation in the isolated worktree', type: 'toggle', default: false },
    { key: 'allowUnattendedRuntime', label: 'Allow unattended runtime', type: 'toggle', default: true, hint: 'Permit non-interactive stream-json execution in Antigravity sandbox (default: true)' },
    { key: 'approvedProjectIds', label: 'Operator-authorized implementation project UUIDs', type: 'text', hint: 'Set via the API as a UUID array; requires verified Paperclip isolated workspaces' },
    { key: 'approvedIssueIds', label: 'Human-approved issue IDs (comma-separated; implementation only)', type: 'text', hint: 'Only these Paperclip issue IDs may be edited; required for dynamic implementation' },
    { key: 'sandbox', label: 'Enable Antigravity terminal sandbox', type: 'toggle', default: true, hint: 'Required; does not isolate all filesystem operations' },
    { key: 'probeAuthentication', label: 'Test model during environment check (may use quota)', type: 'toggle', default: true },
    { key: 'probeTimeoutSec', label: 'Connection test timeout (seconds)', type: 'number', default: 35 },
    { key: 'effort', label: 'Reasoning effort', type: 'select', options: [{label:'CLI default',value:''},{label:'Low',value:'low'},{label:'Medium',value:'medium'},{label:'High',value:'high'}] },
    { key: 'investigationBudget', label: 'Initial investigation tool-call budget', type: 'number', default: 12, hint: 'Prompt guidance only; never kills tools or skips required checks' },
    { key: 'outputInactivityTimeoutMs', label: 'Output inactivity timeout (milliseconds)', type: 'number', hint: 'Positive integer; null disables this monitor. The overall run timeout still applies.' },
    { key: 'timeoutPolicy', label: 'Execution deadline policy', type: 'select', default: 'completion', options: [{label:'Completion driven',value:'completion'},{label:'Explicit wall-clock limit',value:'bounded'}], hint:'Completion driven ignores legacy timeoutSec values. Paperclip owns issue disposition and continuation.' },
    { key: 'timeoutSec', label: 'Wall-clock limit for bounded execution (seconds)', type: 'number', default: 0, hint: 'Applies only when timeoutPolicy is bounded. The adapter alone owns this deadline.' },
    { key: 'graceSec', label: 'Cancellation grace (seconds)', type: 'number', default: 10 },
    { key: 'validateSelectedModelOnRun', label: 'Validate model against live AGY models before execution', type: 'toggle', default: true },
    { key: 'accountPoolFile', label: 'Observed account state file (optional)', type: 'text', hint: 'Does not store or switch credentials' },
    { key: 'promptPolicy', label: 'Resumed conversation prompt policy', type: 'select', default: 'compact_resume', options: [{label:'Compact: send only new task context and active skill paths',value:'compact_resume'},{label:'Legacy: send full prompt on every turn',value:'full_every_turn'}], hint:'Compact mode applies only after a verified previous turn; fresh and legacy sessions receive the full prompt' },
    { key: 'promptTemplate', label: 'Paperclip prompt template (optional)', type: 'textarea', hint: 'Uses Paperclip placeholders like {{agent.name}}, {{context.taskTitle}}' },
  ],
};
