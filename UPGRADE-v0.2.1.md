# Upgrade v0.2.0 → v0.2.1 (macOS test path normalization)

**Scope:** This release changes a test assertion and adds a regression test. The production adapter path validation, Git worktree ownership checks, and session isolation are unchanged.

macOS can expose the same temporary directory as `/var/folders/...` (from `os.tmpdir()`) and `/private/var/folders/...` (from `realpath()`). The assigned-workspace resolver intentionally uses the canonical real path for security. The old test compared it to the uncanonicalized fixture string and failed even though the workspace was correct.

The fixed test compares `resolved.cwd` and `sessionParams.cwd` against `await realpath(f.secondary)`. An additional test verifies an alias pointing to the same registered worktree is canonicalized and that session continuation stays bound to the same issue/worktree.

## Apply (macOS)

```bash
cd ~/IdeaProjects
unzip -o ~/Downloads/paperclip-adapter-antigravity-local-v0.2.1.zip -d ~/IdeaProjects
cd ~/IdeaProjects/paperclip-adapter-antigravity-local
npm run check
npm test
```

Because this only changes tests and the package version, the running adapter does **not** need to be reloaded to correct the test. Optionally run `npx paperclipai adapter reload antigravity_local` if you want Paperclip to show version 0.2.1.

Do **not** modify `src/lib/assigned-workspace.js` to stop canonicalizing paths. Don't disable workspace guards or loosen a failed test. This does not prove successful operation on the live macOS environment; you must run tests on your Mac.
