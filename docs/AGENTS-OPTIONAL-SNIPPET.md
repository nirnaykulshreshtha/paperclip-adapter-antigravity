## Paperclip SDLC and isolated execution workspaces

Paperclip is the issue and worktree orchestrator for approved AI work in YourClientDesk. A feature request first produces a codebase-aware PRD, acceptance criteria, UX decisions, technical plan, task decomposition, and a human approval request.

For code-changing issues, Paperclip must allocate an **isolated Git worktree** from the repository's approved project workspace. The Antigravity adapter must use its assigned `paperclipWorkspace.cwd`; agents must not invent their own checkout or substitute the main working tree. Verify that a task's approved issue ID matches the adapter's explicit allowlist before implementation.

Do not treat enabling the Antigravity adapter as permission to merge, push, run database migrations, access production data, or deploy. These remain explicit human-controlled operations guarded by repository protections, restricted credentials, and CI. Keep workspaces until their changes have been reviewed and preserved. Keep existing `AGENTS.md` architecture, security, Prisma, and test conventions authoritative.

After verification, update `product-status.md` only for material and validated product changes. Graphify is optional for architecture discovery; current source code and tests always take precedence.
