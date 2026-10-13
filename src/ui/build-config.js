import { buildAdapterEnvConfig } from '@paperclipai/adapter-utils';

function parseCommaArgs(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Builds normalized adapter configuration for Antigravity from Paperclip UI form values.
 * Pure function suitable for browser execution inside the Paperclip Dashboard.
 */
export function buildAntigravityLocalConfig(v = {}) {
  const ac = {};

  if (v.command) ac.command = v.command;
  if (v.model) ac.model = v.model;
  if (v.effort) ac.effort = v.effort;
  if (v.cliAgent) ac.cliAgent = v.cliAgent;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;

  // Workspace configuration
  if (v.workspaceMode) ac.workspaceMode = v.workspaceMode;
  if (v.cwd) ac.cwd = v.cwd;
  if (v.repositoryRoot) ac.repositoryRoot = v.repositoryRoot;
  if (v.allowedWorkspaceRoot) ac.allowedWorkspaceRoot = v.allowedWorkspaceRoot;

  // Execution mode and implementation authorizations
  if (v.executionMode) ac.executionMode = v.executionMode;
  if (typeof v.enableImplementation === 'boolean') {
    ac.enableImplementation = v.enableImplementation;
  }
  if (v.approvedIssueIds) {
    ac.approvedIssueIds = parseCommaArgs(v.approvedIssueIds);
  }
  if (v.approvedProjectIds) {
    ac.approvedProjectIds = Array.isArray(v.approvedProjectIds)
      ? v.approvedProjectIds
      : parseCommaArgs(v.approvedProjectIds);
  }
  if (typeof v.allowUnattendedRuntime === 'boolean') {
    ac.allowUnattendedRuntime = v.allowUnattendedRuntime;
  }

  // Operational timeouts and safety policies
  if (typeof v.timeoutSec === 'number') ac.timeoutSec = v.timeoutSec;
  if (v.outputInactivityTimeoutMs === null) {
    ac.outputInactivityTimeoutMs = null;
  } else if (typeof v.outputInactivityTimeoutMs === 'number') {
    ac.outputInactivityTimeoutMs = v.outputInactivityTimeoutMs;
  }
  if (typeof v.graceSec === 'number') ac.graceSec = v.graceSec;
  if (typeof v.probeAuthentication === 'boolean') ac.probeAuthentication = v.probeAuthentication;
  if (typeof v.probeTimeoutSec === 'number') ac.probeTimeoutSec = v.probeTimeoutSec;
  if (typeof v.validateSelectedModelOnRun === 'boolean') {
    ac.validateSelectedModelOnRun = v.validateSelectedModelOnRun;
  }
  if (v.promptPolicy) ac.promptPolicy = v.promptPolicy;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.accountPoolFile) ac.accountPoolFile = v.accountPoolFile;

  // Environment bindings
  if (v.envBindings || v.envVars) {
    const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
    if (Object.keys(env).length > 0) ac.env = env;
  }

  return ac;
}
