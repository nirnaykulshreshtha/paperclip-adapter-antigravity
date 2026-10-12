# Upgrade from v0.1.6 to v0.2.0

This version adds dynamic Paperclip worktree support. It intentionally requires a new `workspaceMode: paperclip` and primary checkout trust configuration, rather than pretending the fixed-worktree settings can authorize any directory.

1. Download and unzip package over the previous source; do not modify YourClientDesk application files.
2. Run `npm run check && npm test` (39 tests including dynamic worktrees).
3. Reload adapter with `npx paperclipai adapter reload antigravity_local` and confirm `version=0.2.0`.
4. Configure project primary workspace and enable isolated issue worktrees in Paperclip.
5. Create an external dedicated worktree parent and operator marker.
6. Switch ONE agent to `workspaceMode: paperclip` in **planning mode** with implementation disabled.
7. Test an isolated issue run and inspect its branch and logs; verify `--mode=plan` and no unapproved writes.
8. After a human-approved task plan, promote exactly one engineer, allowlisting one issue ID and updating its planning-only role instructions.
9. Revoke mode and issue allowlist after the approved code-change run; require a human for PR merge, migrations and deploy.

The previous `workspaceMode: fixed` behavior remains for existing pilots. The ZIP does not change an existing Paperclip agent until you explicitly update its adapter configuration.
