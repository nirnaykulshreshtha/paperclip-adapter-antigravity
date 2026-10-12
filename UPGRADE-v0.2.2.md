# Upgrade from v0.2.1 to v0.2.2 — Paperclip skill bridge

Paperclip team repair v2.1 finished agent instruction, permission and skill assignment updates; `antigravity_local` v0.2.1 could not deliver skills. This release adds `listSkills`, `syncSkills` and actual per-run read-on-demand skill delivery.

## Runtime architecture

1. Paperclip supplies `adapterConfig.paperclipSkillSync.desiredSkills` and `paperclipRuntimeSkills` inventory to the adapter. `requiresMaterializedRuntimeSkills: true` tells Paperclip to prepare file sources before an execution.
2. Only skills **explicitly assigned to the agent** are accepted. Missing assigned sources cause the run to fail **before spawning `agy`**. No automatic company-wide fallback or global skill installation.
3. Before each run, source directories are copied to a private temporary `.agents/skills/<runtimeName>` tree. File symlinks, path traversal and oversized bundles are rejected. Script execute permissions are retained but scripts are **never auto-executed**.
4. The run prompt contains a compact skills index with absolute paths, rather than injecting every full `SKILL.md`. `agy` receives `--add-dir <temporary-parent>` so it can read the selected packages when relevant. Paths are disclosed only to that run.
5. The temporary bundle is removed on success, failure or cancellation. No application repository or global Antigravity skills folder is modified.

**Important:** This is prompt-guided on-demand delivery via `--add-dir`, not proof that Antigravity's native skill auto-discovery scans arbitrary `--add-dir` directories. The Paperclip UI can now show the bridge as `ephemeral`; a real macOS run must confirm the agent successfully reads and cites an assigned skill. Do not enable coding automatically.

## Install

```bash
cd ~/IdeaProjects
unzip -o ~/Downloads/paperclip-adapter-antigravity-local-v0.2.2.zip -d .
cd ~/IdeaProjects/paperclip-adapter-antigravity-local
npm run check
npm test
npm run models:check
npx paperclipai adapter reload antigravity_local
```

If `adapter list` shows an old version/capability or `skills agent list` remains `unsupported`, restart the **actual Paperclip server** (not `service restart` when the managed service isn't installed), as the Node module cache can retain old child modules.

## Check saved assignments and snapshots

```bash
COMPANY=a0ffec02-2448-4237-866e-d54eefb51aad
LEAD=85e5fde5-893e-4bed-92a1-267c39050bd2
npx paperclipai adapter list | grep antigravity
npx paperclipai skills agent list "$LEAD" --company-id "$COMPANY" --json
```

Expected: `supported: true`, `mode: "ephemeral"`, assigned skills present with `state: "installed"`, and no missing-source warnings. "Installed" means **ready to be staged per run**, not globally installed or proven used by an AI model.

## Supervised end-to-end validation (uses model tokens)

Keep `executionMode: planning`, `enableImplementation: false`, `approvedIssueIds: []`, heartbeats disabled. Create/assign a Paperclip **planning** issue to the Delivery Lead after Paperclip isolated workspaces are configured. Ask:

> Inspect your assigned Paperclip skills, open the `yourclientdesk-sdlc-governance` SKILL.md, and report its filename, a distinctive rule from the file, and the current task workspace path. Do not edit files, create branches, or execute scripts.

Verify the issue run succeeded, the expected skill's actual file was read, and the issue worktree is clean. Compare its rule with the company library. There is no reliable guarantee of autonomous native CLI auto-discovery until this live check passes.

If the run reports `Assigned skill ... unavailable`, check the Paperclip company skill entry and `Agent → Skills` tab, not the Antigravity model list.

## Scope and limits

- The upstream team repair skipped seven optional skills that were not in the company library. Add them separately from trusted local sources only if useful.
- No changes to `agy models` discovery (live-only); no static model fallback.
- Worktree validation, issue allowlist and protected operations are unchanged.
- Worktree/path checks, `--sandbox` and read-only planning do not provide OS-level isolation. Merge, production DB migrations and deployment remain human-approved and require independent controls.
- This package has been tested with mocked CLI execution, not on your Mac's actual `agy` binary and Paperclip server.
