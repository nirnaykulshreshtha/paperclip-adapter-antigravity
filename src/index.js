export const type = 'antigravity_local';
export const label = 'Antigravity CLI (local, controlled)';
// Required Paperclip metadata field; the list is provided ONLY by live listModels/refreshModels.
export const models = [];
export const agentConfigurationDoc = `# Antigravity CLI — Paperclip workspace-aware adapter

- Select an explicit model from live agy models; no static list, default fallback, or model inference during discovery.
- For dynamic issues set workspaceMode=paperclip, repositoryRoot to the trusted primary checkout, and allowedWorkspaceRoot to a dedicated parent for generated issue worktrees.
- Add .paperclip-antigravity-allow with content ALLOW_PAPERCLIP_ANTIGRAVITY_LOCAL under allowedWorkspaceRoot ONCE. Paperclip must create worktrees; the adapter never does.
- The adapter accepts Paperclip context.paperclipWorkspace.cwd only after checking path containment, Git repository identity, registration, and non-protected branch.
- The primary checkout is always rejected for dynamic task execution.
- Planning tasks pass --mode=plan and --sandbox. Implementation mode passes --mode=default, requires enableImplementation=true, a task ID and execution workspace ID.
- Never use production credentials in agent worktrees. Terminal sandbox is not OS-level isolation. Permission denial is an error.
- No agent may merge, deploy, execute production database migrations, or push automatically. Protect main using branch permissions and human review outside this adapter.
- Session resume requires the same task and canonical workspace, and (if previously bound) the same workspace ID.
- Legacy fixed-worktree mode remains available for temporary pilot testing. Upgrade to paperclip mode for implementation.
- Set probeAuthentication=false after authenticating once; probes use account tokens.
`;
export { createServerAdapter } from './server/index.js?v=0.2.11';
