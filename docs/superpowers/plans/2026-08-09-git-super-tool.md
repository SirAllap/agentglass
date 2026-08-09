# Git Super Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing lazygit-style Source Control panel into a full git client — cherry-pick, revert, amend, squash, interactive rebase, compare refs, WIP snapshots and reflog recovery — so nobody needs the terminal for history surgery. Flagship: **cherry-pick** (multi-commit, no-commit, conflict continue/abort) reusing the existing conflict machinery.

**Architecture:** Everything is a new operation in `server/src/gitwork.ts` (the engine), exposed as `/git/*` REST endpoints in `server/src/index.ts` behind the existing `guard()` (write-gate + project scope), typed in `shared/types.ts`, rendered in `web/src/components/GitPanel.tsx` (log-graph context menus + new views). No new dependencies. Patterns borrowed from the gitcito reference (see Analysis): `git cherry-pick h1 h2 h3` in one sequencer run, `rev-parse --git-path` state probes, `\x1f`/`\x1e` record-separator parsing, `-c sequence.editor='cp <todo>'` for programmatic rebase.

**Tech Stack:** Bun + TypeScript on the server (`bun test` in `server/`), React 18 + Tailwind on the web side (`bun test` in `web/`), `make typecheck` gate.

## Analysis

### What gitcito (the reference) is

A vibe-coded Electron + React git GUI. Its whole engine is one file (`src/main/git.ts`, ~140 methods) exposed through one IPC channel with a per-repo RwLock where the read-only allow-list defaults everything else to write. Two execution paths: `simple-git` library (serializes ops per repo → no index.lock collisions) and raw `execFile`. No command timeouts anywhere; safety comes from `GIT_TERMINAL_PROMPT=0` and its lock.

The most valuable stealable pieces, with their gitcito locations:

| Idea | gitcito location | Why it matters for agentglass |
|---|---|---|
| Multi-commit cherry-pick in ONE call (`cherry-pick h1 h2 h3`) | `git.ts:1857-1872` | Git's own sequencer handles per-commit state, conflicts pause the whole run |
| `mergeState` probe via `rev-parse --git-path` + file existence (`CHERRY_PICK_HEAD`/`REVERT_HEAD`/`rebase-merge`/`MERGE_HEAD`) | `git.ts:740-749` | agentglass already has this as `treeState()` in `gitwork.ts:177-186` |
| Conflict stages via `git show :1/:2/:3:file` | `git.ts:768-785` | Matches the existing `conflictBlocks`/merge-session machinery |
| Interactive rebase via `-c sequence.editor='cp <tmp todo>'` + `core.editor=true`, reword as `exec git commit --amend -m '...'` | `git.ts:2495-2540` | The only way to drive `rebase -i` non-interactively |
| `withAutoStash` (dirty-tree transaction: stash --include-untracked, op, pop) | `git.ts:226-238` | ~12 lines, protects every history-surgery op from dirty trees |
| Reflog as the undo net (`reflog show --format=%H%gD%gs%ct`) | `git.ts:2562-2575` | agentglass already has `reflog()` (`gitwork.ts:2908`) and a Reflog view — wire "reset here" into it |
| WIP snapshots: `stash create` → commit under `refs/gitcito/wip/<ts>` via `update-ref`, restore with `stash apply <sha>` | `git.ts:2929-2978` | A "save without touching" safety net, gc-safe ref, never touches stash list |
| Record/field-separator parsing (`\x1f` fields, `\x1e` records, `-z` for paths) | `git.ts:66-67, 587-649` | Robust against every character in commit data |
| `squashCommits`: soft reset to `oldest^` + commit, `ORIG_HEAD` as undo point | `git.ts:1179-1183` | 5 lines, and `ORIG_HEAD` gives free undo |
| `buildLinePatch` — recompute `@@` counts to stage/apply partial diffs | renderer `DiffViewer.tsx:73-125` | How `git add -p` semantics get reproduced in code; feeds `git apply --cached` |
| Protected branches stored in git config, force push only ever `--force-with-lease` | `git.ts:1206, 1449-1462` | Cheap and high-value guardrails |
| `isSecretFile` heuristics (`.env*`, `*.pem`, `id_rsa`, `credentials.*`, allow-list `.env.example`) | `shared/secretFiles.ts` | Display-only masking in diff views |
| `generateChangelog` (conventional-commits regex + group bucketing) | `git.ts:2846-2921` | Bonus feature, self-contained |
| `repoInsights` (`git log --numstat -M` with `\x01`-prefixed commit markers) | `git.ts:2719-2839` | Bonus "Insights" dashboard |

### What agentglass already has

- **Engine** `server/src/gitwork.ts` (3723 lines): repo discovery + scope, `workingTree`, stage/unstage/discard (tracked/untracked split), `commitStaged`, push/`pull --ff-only`/fetch + auto-fetch, `branches()` with squash/rebase merged-detection, `logGraph` (custom graph renderer!), merge + `undoMerge`, rebase, rename, `resetTo(soft|mixed|hard)`, **full conflict machinery** (`conflicts`, `conflictBlocks`, `resolveBlocks`, `mergeSession`, `resolveWith` ours/theirs, `mergeContinue`/`mergeAbort`, `prepareConflictMerge`), worktrees with `rescueLeftovers`/`fixWorktreeOwnership`, remotes, remote branch tracking, tags, reflog, stashes, `applyHunk` (hunk-level stage/discard).
- **State detection already knows about history surgery**: `treeState()` (`gitwork.ts:177-186`) returns `cherry-picking`/`reverting`/`bisecting`/`rebasing`, and `mergeAbort` already runs `revert --abort` for reverts (`gitwork.ts:1775`).
- **UI** `GitPanel.tsx` (3096 lines): tabs `changes | log | reflog | branches | remotes | tags | stashes | worktrees | tidy` + a log-graph view, conflict resolver, commit composer.
- **Transport**: REST `/git/*` endpoints (POST with `{ root, ... }` body or GET with `?root=`), e.g. `web/src/lib/api.ts:537-622`. Every mutation goes through `guard()` (`gitwork.ts:679-687`) = `GIT_WRITE_ENABLED` + project scope. Mutations call `run()` which invalidates merged/repo/behind caches and fires the `onGitChange` nudge.
- **git adapter** `server/src/git.ts`: `Bun.spawnSync` with `PINNED` `-c` overrides (`diff.mnemonicPrefix=false`, `core.quotepath=false`, `color.ui=false` — real-world bugs these fixed), **15 s timeout**, spawnpool-capped `gitAsync` for parallel reads.

### The gap (gitcito vs agentglass)

| Operation | agentglass today | gitcito | Plan |
|---|---|---|---|
| **Cherry-pick** | state detected, no trigger | yes (multi, `-n`, conflicts) | **Task 1-3** |
| **Revert** | state detected, no trigger | yes (`--no-edit`) | Task 4 |
| **Amend** | no | yes | Task 4 |
| **Squash multi-commit** | no | yes (soft-reset trick) | Task 4 |
| **Interactive rebase** | plain `rebaseBranch` only | full drag/reorder/squash/fixup/reword/drop | Task 5 |
| **Compare refs (ahead/behind + diff)** | `baseCandidates`/`syncFromBase` partial | full | Task 6 |
| **WIP snapshots / auto-stash** | no | yes | Task 7 |
| **Reflog → reset-here recovery** | reflog listed only | reset from any entry | Task 7 |
| **Protected branches + `--force-with-lease`** | no | yes | Task 8 |
| **Partial stash / stash rename / stash→branch** | apply/pop/drop only | yes | Task 9 |
| **Tags — annotated/signed, push/delete remote** | list only | yes | Task 15 |
| **Insights / changelog** | no | yes | Task 10 (bonus) |
| **Submodules — add/update/sync/remove** | no | yes | Task 11 |
| **Per-file blame + history (follow-the-line)** | no | yes | Task 12 |
| **Guided bisect** | state detected, no UI | yes | Task 13 |
| **Commit search/filter + code search (pickaxe -S/-G)** | no | yes | Task 14 |
| **Large-file + secret-push guards** | no | yes | Task 8 |
| **Word-level diff / split view / line-level staging** | hunk-level only | partial | Bonus |
| **Git LFS, sparse-checkout, patches, hooks manager, signing** | no | yes | Bonus tier |
| **Stacked branches (Graphite-style)** | no | **out of scope** — agentglass already has worktrees + Tasks→PR flow; a restack cascade on top of a fleet dashboard earns less than submodules/bisect. Revisit post-v0.11 if asked | — |

## Global Constraints

- **Execution**: all work happens in a local `git worktree` (sibling folder), one worktree per task-track, **never push to any remote** — hand off by branch name + summary.
- Spec lives here; no separate design doc needed — the Analysis above is the design.
- Every mutating op goes through `guard()` then `run()` in `gitwork.ts` — do NOT bypass; new ops must invalidate the same caches and fire the same nudge (already handled by `run()`).
- Long operations (multi-commit cherry-pick, rebase) can exceed the 15 s `git()` timeout. Use `gitAsync` (spawnpool-capped, but spawnSync under the hood — check `spawnpool.ts`; if the pool is sync-blocking, add a bounded async variant with a 60 s timeout for history ops).
- Never a shell string: arg arrays only. `-C <root>` always. `GIT_TERMINAL_PROMPT=0` must be in env for every new call (prompts would hang the server).
- Reuse `treeState()`/`mergeSession`/`conflictBlocks` for cherry-pick conflicts — do NOT write a parallel conflict path. `conflictBrief.ts` already renders cherry-pick ours/theirs semantics.
- `GitActionResult` stays the mutation return shape (`{ ok, error?, output? }`) — the panel's `act()` helper depends on it.
- New types go in `shared/types.ts`; new endpoints in `index.ts` near the existing `/git/*` block; API wrappers in `web/src/lib/api.ts`; UI in `GitPanel.tsx` (context menus on the log-graph rows + new view tabs).
- UI copy should match the panel's existing tone (short, imperative, terse titles).
- Tests: `server/test/` with `bun test`, real fixture repos (see existing gitwork tests); `cd web && bun test` for any UI logic extracted into `web/src/lib/`.
- Run `make typecheck` before finishing; `make test` where feasible.

---

### Task 1: Cherry-pick engine

**Files:**
- Modify: `server/src/gitwork.ts` (near `resetTo` / the merge block)
- Modify: `shared/types.ts`
- Test: `server/test/gitwork-cherry-pick.test.ts`

**Interfaces:**
- Consumes: `treeState()` (`gitwork.ts:177`), `conflicts()` (`gitwork.ts:1743`), `mergeContinue`/`mergeAbort` (`gitwork.ts:1786/1769`), existing `GitActionResult`.
- Produces: `cherryPick(root, hashes, opts: { noCommit?: boolean })` and `cherryPickContinue(root)` / `cherryPickAbort(root)`.

- [ ] **Step 1: Types.** Add to `shared/types.ts` next to `MergeInfo`:
```ts
export type CherryPickRequest = { root: string; hashes: string[]; noCommit?: boolean };
```
No new response type — `GitActionResult` covers it.

- [ ] **Step 2: Engine.** In `gitwork.ts`:
```ts
export function cherryPick(rootIn: string, hashesIn: unknown, noCommit?: boolean): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const hashes = ... // validate: array of non-empty strings, 7-40 chars, /^[0-9a-f]+$/i — reject refs like "HEAD" or branch names
  const args = ["cherry-pick"];
  if (noCommit) args.push("-n");
  args.push(...hashes);            // ONE call → git's sequencer runs them in order
  return run(root, args);          // run() = guard-aware, cache-invalidate, nudge
}
```
Also `export function cherryPickContinue(rootIn)` → `run(root, ["cherry-pick", "--continue"])` and `cherryPickAbort(rootIn)` → `run(root, ["cherry-pick", "--abort"])`.
Note the conflict-continue editor trap: plain `--continue` can open an editor when a conflict was resolved. If `run` ever hangs there, pass `-c core.editor=true` (see gitcito `git.ts:802-814`; and its `allowUnsafeEditor` gotcha does not apply here — agentglass uses raw argv, no simple-git).

- [ ] **Step 3: Guard against mid-state.** Refuse a new cherry-pick when `treeState(root) !== "clean"` (a repo mid-merge must not start a second sequencer run). Error message names the state.

- [ ] **Step 4: Tests.** Fixture: create a repo in `server/test/`, commit A, B, C on a side branch, checkout main, `cherryPick([B, C])` → main tip subject is C, log contains B and C; conflict case: make C edit the same line as an existing main commit → `ok:false`, then `conflicts()` lists the file, `mergeContinue` after resolving with `resolveWith(root, [file], "theirs")` completes the pick. Assert `-n` mode stages without committing (index has the change, HEAD untouched). Assert bad-hash and mid-state rejections.

### Task 2: Cherry-pick endpoint + API wrapper

**Files:**
- Modify: `server/src/index.ts` (the `/git/*` block)
- Modify: `web/src/lib/api.ts`

**Interfaces:**
- Consumes: Task 1 engine.
- Produces: `POST /git/cherry-pick`, `POST /git/cherry-pick-continue`, `POST /git/cherry-pick-abort`.

- [ ] **Step 1: Endpoints.** Three POST handlers beside the existing `merge-abort`/`merge-continue` (`index.ts` near line 2350). Body: `{ root, hashes?, noCommit? }`. Must respect the Origin-validation rule (#496) the other mutating routes use.
- [ ] **Step 2: API wrappers.** In `web/src/lib/api.ts` next to `gitReset` (`api.ts:595`):
```ts
gitCherryPick: (root: string, hashes: string[], noCommit?: boolean) => post<GitActionResult>("/git/cherry-pick", { root, hashes, noCommit }),
gitCherryPickContinue: (root: string) => post<GitActionResult>("/git/cherry-pick-continue", { root }),
gitCherryPickAbort: (root: string) => post<GitActionResult>("/git/cherry-pick-abort", { root }),
```

### Task 3: Cherry-pick UI (the flagship)

**Files:**
- Modify: `web/src/components/GitPanel.tsx` (log view rows + `logGraph` graph)
- Modify: `web/src/lib/conflictBrief.ts` if the merge-paused banner needs a cherry-pick label check

**Interfaces:**
- Consumes: Task 2 API wrappers, existing `act()` helper, existing merge-paused banner (`GitPanel.tsx:2402-2406` region).
- Produces: row context menu with **Cherry-pick onto current**, multi-select via `⇧`/`⌘`-click (check whether log rows are selectable today; if not, add a minimal selection set), and a paused-cherry-pick banner with Continue/Abort wired to the new endpoints.

- [ ] **Step 1: Context menu on log rows.** Right-click a commit row → menu: Cherry-pick (single) / Cherry-pick (no commit), Revert, Copy SHA, Create branch here, Reset here (soft/mixed/hard — reuse `gitReset`). Menu component exists: `ContextMenu.tsx` — check how it is used by other panels and match it.
- [ ] **Step 2: Multi-select.** `⇧`-click range + `⌘`-click toggle on log rows; when ≥2 selected show "Cherry-pick N commits (in order)". Order: oldest first (reverse of selection if user selected top-down).
- [ ] **Step 3: Paused state.** When `tree.state === "cherry-picking"` show the merge-paused style banner with the conflict files (reuse `conflicts()`), Continue and Abort buttons. The state already flows through `workingTree()` → `GitTreeState`.
- [ ] **Step 4: Toast copy.** Success: `cherry-picked <sha-short>`; conflict: surface the `run()` error (`CONFLICT (...)`), leave the sequencer paused.

### Task 4: Revert, amend, squash

**Files:**
- Modify: `server/src/gitwork.ts`, `server/src/index.ts`, `web/src/lib/api.ts`, `web/src/components/GitPanel.tsx`, `web/src/components/CommitModal.tsx`

**Interfaces:**
- Consumes: Task 1's patterns.
- Produces: `revert(root, hash)`; `amend(root, title, body)`; `squashCommits(root, oldestHash, newestHash)`.

- [ ] **Step 1: Revert.** `git revert --no-edit <hash>` (non-interactive editor kill). Endpoint `POST /git/revert`. Conflict path = same as cherry-pick (`REVERT_HEAD` already detected by `treeState`; `mergeAbort` already aborts reverts). Menu entry in Task 3's context menu.
- [ ] **Step 2: Amend.** `git commit --amend -m title [-m body]` — only when `treeState === "clean"` besides staged changes; refuse when mid-op. In `CommitModal.tsx`, add an "Amend" toggle next to Commit that calls it instead.
- [ ] **Step 3: Squash.** Multi-select on log → "Squash N commits": verify contiguous run (walk `rev-list oldest..newest` length equals N and newest is an ancestor of HEAD; otherwise refuse). Implement per gitcito: soft `reset --soft oldest^` + `commit -m` with `ORIG_HEAD` left as the undo point (`gitcito git.ts:1179-1183`). Endpoint `POST /git/squash`.
- [ ] **Step 4: Tests** for all three (fixture repos: revert order, amend replaces message, squash produces one commit whose tree equals the squashed tip, `ORIG_HEAD` points at the old tip).

### Task 5: Interactive rebase

**Files:**
- Modify: `server/src/gitwork.ts`, `server/src/index.ts`, `web/src/lib/api.ts`
- Create: `web/src/components/RebaseModal.tsx`
- Test: `server/test/gitwork-rebase.test.ts`

**Interfaces:**
- Consumes: `logGraph`/`gitLog` for step enumeration.
- Produces: `rebaseSteps(root, base): RebaseStep[]` (read-only) and `runRebase(root, base, steps)` (mutating); types `RebaseStep = { action: "pick"|"squash"|"fixup"|"drop"|"reword"|"edit"; hash: string; subject: string; newMessage?: string }`.

- [ ] **Step 1: Enumeration.** `git log --reverse base..HEAD --format=%H\x1f%s\x1e` (the `\x1f`/`\x1e` record parsing from the Analysis table — reuse `parseDiff`-style splitting, or the separator constants already in `gitwork.ts` if present).
- [ ] **Step 2: Todo execution.** Write the todo list to a temp file, then:
```
git -C <root> -c sequence.editor='cp <tmpfile>' -c core.editor=true rebase -i <base>
```
gitcito's exact approach (`git.ts:2508-2540`). Reword = `pick` + `exec git commit --amend -m '<escaped>'` line (`\` → `\\`, `'` → `'\''`). Drop = `drop <shortsha> <subject>`. Use `gitAsync`-style bounded timeout (rebases are not instant).
- [ ] **Step 3: UI.** `RebaseModal.tsx`: pick a base (or "from this commit" from the log context menu), render steps, drag to reorder (check for a drag util already used in the codebase — `GitPanel` reorders tabs? if none, up/down buttons), per-row action dropdown (pick/squash/fixup/reword/drop/edit). Reword shows a message input. "Start rebase" button; on conflict, `treeState` reports `rebasing` and the existing merge-paused UI must offer `rebase --continue`/`--abort` — add those two to `mergeContinue`/`mergeAbort`'s state switch (`gitwork.ts:1770-1790` area) if not already handled.
- [ ] **Step 4: Tests.** Reorder swaps commit order; squash folds; drop removes; reword changes message; conflict pauses with `treeState()==="rebasing"` and abort restores the original `ORIG_HEAD`-safe state.

### Task 6: Compare refs

**Files:**
- Modify: `server/src/gitwork.ts`, `server/src/index.ts`, `web/src/lib/api.ts`
- Create: `web/src/components/CompareModal.tsx`

**Interfaces:**
- Consumes: `baseCandidates()` (`gitwork.ts:1871`) for the ref picker.
- Produces: `compareRefs(root, base, other): { ahead: GitCommit[]; behind: GitCommit[]; diff: GitFileChange[] }`.

- [ ] **Step 1: Engine.** `git log other..base` (ahead), `base..other` (behind), `git diff other...base` → `GitFileChange[]` via the existing diff parser (`parseDiff` at `gitwork.ts:75`). Two async calls via `gitAsync`, one diff.
- [ ] **Step 2: Endpoint + wrapper** (`GET /git/compare?root=&base=&other=`).
- [ ] **Step 3: UI.** Modal from the branches view ("compare with current") and the log header: base/other pickers with swap button, ahead/behind counts, unified diff list reusing the existing `ChangesModal`/file-diff rendering. Offer "open a PR" only if `prs.ts` already exposes the shape (else leave a "checkout base" affordance).

### Task 7: Safety net — WIP snapshots + reflog recovery

**Files:**
- Modify: `server/src/gitwork.ts`, `server/src/index.ts`, `web/src/lib/api.ts`
- Modify: `web/src/components/GitPanel.tsx` (reflog view)
- Test: `server/test/gitwork-snapshots.test.ts`

**Interfaces:**
- Produces: `createSnapshot(root, label?)`, `listSnapshots(root)`, `restoreSnapshot(root, sha)`, `deleteSnapshot(root, sha)`; snapshot type `{ sha, ref, time, label }`.

- [ ] **Step 1: Snapshots.** `git stash create -m <label>` (makes a commit, touches NOTHING), then `git update-ref refs/agx/wip/<timestamp> <sha>`. List via `for-each-ref refs/agx/wip --format=%(refname:short)\x1f%(objectname:short)\x1f%(creatordate:iso8601)`. Restore = `git stash apply <sha>` (or `git stash apply <sha> --index`), delete = `update-ref -d`. Cap at 30, prune oldest on create (gitcito pattern `git.ts:2929-2978`).
- [ ] **Step 2: Reflog recovery.** In the existing Reflog view, each entry gets "reset here" (hard reset with a confirm dialog — the panel already confirms destructive ops) and "copy SHA". Reuses `gitReset` from `api.ts:595`.
- [ ] **Step 3: Auto-stash on history surgery.** Wrap cherry-pick/rebase/pull in `withAutoStash`: if `git status --porcelain` is non-empty, `stash push --include-untracked -m "agx: auto-stash before <op>"`, run, then `stash pop`. On failure leave the stash and report its index in the error (gitcito `git.ts:226-238`). Do this in the engine, not the UI.
- [ ] **Step 4: Tests.** Snapshot round-trip (dirty tree → snapshot → clean → restore → dirty again), prune cap, reflog reset restores a hard-reset casualty.

### Task 8: Guardrails — protected branches + force-with-lease

**Files:**
- Modify: `server/src/gitwork.ts` (the `push` function at `gitwork.ts:796` and `resetTo` at `gitwork.ts:1371`)

**Interfaces:**
- Produces: `protectedBranches(root)`, `setProtectedBranches(root, names)`; `push(root, opts: { force?: boolean })`.

- [ ] **Step 1: Storage.** In git config (like gitcito): `git config agx.protectedbranches` comma-joined, default `main,master`. Read + write helpers.
- [ ] **Step 2: Enforcement.** `resetTo` with `hard` refuses when current branch is protected (unless an explicit `force` flag). Commit-to-protected shows a one-click confirm in the UI (`CommitModal`). Add `--force-with-lease` (never `--force`) support to `push` behind an explicit UI confirm.
- [ ] **Step 3: Tests.** Protected reset refuses; unprotected allows; config round-trip.

### Task 9: Stash power-ups

**Files:**
- Modify: `server/src/gitwork.ts` (`stashPush`/`stashOp` area, `gitwork.ts:2941-2957`), `server/src/index.ts`, `web/src/lib/api.ts`, `web/src/components/GitPanel.tsx` (stashes view)

**Interfaces:**
- Produces: `stashRename(root, index, message)`, `stashToBranch(root, index, branch)`, `stashPartial(root, paths, keepIndex?)`, `stashApplyOverwrite(root, index)`.

- [ ] **Step 1: Rename.** Rewrite the reflog line (`logs/refs/stash`), preserving the `WIP on <branch>:` prefix (gitcito `git.ts:1266-1287`).
- [ ] **Step 2: To branch.** `git stash branch <branch> stash@{<i>}`.
- [ ] **Step 3: Partial stash.** `git stash push -- <paths> [--keep-index]` from file checkboxes in the stash view.
- [ ] **Step 4: Apply overwrite.** For stashes that won't apply cleanly: delete colliding working-tree paths then `git stash apply` (gitcito `stashApplyOverwrite`, `git.ts:1289-1313`) — behind a confirm.
- [ ] **Step 5: Tests** for rename (message changes, prefix preserved) and to-branch.

### Task 10: Bonus — insights + changelog

**Files:**
- Create: `server/src/gitinsights.ts`
- Modify: `server/src/index.ts`, `web/src/lib/api.ts`
- Create: `web/src/components/InsightsModal.tsx`

**Interfaces:**
- Produces: `repoStats(root, days)` → `{ commitsPerDay, contributors, filesTouched, linesChanged, churn[], topContributors[], hotspots[] }`; `generateChangelog(root, from?, to?)` → markdown.

- [ ] **Step 1: Stats.** `git log --no-merges --since=... --pretty=%at\x1f%an\x1f%ae\x1e` + `git log --numstat -M --since=...` with `\x01`-prefixed commit markers to disambiguate rows from numstat lines (gitcito `repoInsights`, `git.ts:2719-2839`). All `gitAsync` (fan-out, must not block the loop).
- [ ] **Step 2: Changelog.** Conventional-commits regex `^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$`, breaking changes first, grouped Features/Fixes/Performance, `from`/`to` default latest tag → HEAD.
- [ ] **Step 3: UI.** Modal reachable from the repo picker header; simple stat cards + a churn sparkline (reuse an existing chart primitive if one exists — check `Kpis.tsx`/`Throughput.tsx`).

### Task 11: Submodules

**Files:**
- Modify: `server/src/gitwork.ts`, `server/src/index.ts`, `web/src/lib/api.ts`, `web/src/components/GitPanel.tsx` (new view or fold into remotes)

**Interfaces:**
- Produces: `submodules(root)` read + `submoduleAdd(root, url, path)`, `submoduleUpdate(root, path?)`, `submoduleSync(root)`, `submoduleDeinit(root, path)`, `submoduleRemove(root, path)`.

- [ ] **Step 1: Read.** Three-source merge like gitcito (`git.ts:2302-2379`): `.gitmodules` config parse, `git submodule status` (initialized/uninitialized/modified prefixes `-`/`+`/`U`), and gitlink `ls-tree` entries (mode `160000`) for sha + ahead/behind.
- [ ] **Step 2: Write ops.** Add (`submodule add <url> <path>`), update (`submodule update --init --recursive` for the picked ones, or `--remote` variant), sync (`submodule sync --recursive`), deinit (`submodule deinit -f`), remove (deinit + `git rm` + strip `.gitmodules` block + remove dir).
- [ ] **Step 3: UI.** Submodule rows in a sidebar/remotes view with per-module status chip and act buttons; `update` runs via `gitAsync` (network op — never block the loop).
- [ ] **Step 4: Tests.** Fixture with a nested repo added as a submodule; status reads `+`/`-`; remove strips `.gitmodules`.

### Task 12: Per-file blame + history

**Files:**
- Modify: `server/src/gitwork.ts`, `server/src/index.ts`, `web/src/lib/api.ts`, `web/src/components/GitPanel.tsx` (blame view / modal), `web/src/lib/`

**Interfaces:**
- Produces: `blameFile(root, path, ref?)` → `BlameLine[]`; `fileHistory(root, path)` → `FileHistoryEntry[]`; endpoint `GET /git/blame?root=&path=&ref=`.

- [ ] **Step 1: Blame.** `git blame --line-porcelain <ref> -- <path>` — the parser maps `\t`-separated fields (commit sha, original line, final line, group count) + `author`, `author-time` lines; gitcito's `blame --line-porcelain` parse (`git.ts:2204-2221`) is directly portable.
- [ ] **Step 2: History.** `git log --follow --format=%H\x1f%an\x1f%at\x1f%s\x1e -- <path>`.
- [ ] **Step 3: UI.** Blame opens as a side panel next to the file preview (`PeekFile`/editor integration — check `editor.ts`); a right-click **"blame"** on any changed file row; clicking a blame line scrolls to the commit. Follow-the-line jump into the diff, and a "reblame before this commit" affordance if cheap.
- [ ] **Step 4: Tests.** Blame on a fixture file after two commits; `--follow` rename case.

### Task 13: Guided bisect

**Files:**
- Modify: `server/src/gitwork.ts`, `server/src/index.ts`, `web/src/lib/api.ts`
- Create: `web/src/components/BisectModal.tsx`

**Interfaces:**
- Consumes: `treeState()` already returns `"bisecting"` (`gitwork.ts:184`) — the plumbing exists.
- Produces: `bisectStatus(root)`, `bisectStart(root, bad, good)`, `bisectMark(root, "good"|"bad")`, `bisectReset(root)`.

- [ ] **Step 1: Engine.** `bisect start` / `bisect bad <sha>` / `bisect good <sha>` then `bisect status` — parse the human progress text with regexes like gitcito's `buildBisectStatus` (`git.ts:480-529`): `"Bisecting: N revisions left"`, `"<sha> is the first bad commit"`, and the `BISECT_HEAD` sha.
- [ ] **Step 2: UI.** Modal when a checkout is mid-bisect: current candidate sha + subject, mark good/bad buttons, remaining count, and when done — the first-bad commit with a one-click "create branch at / view diff".
- [ ] **Step 3: Tests.** Fixture with a known bad commit; mark through the range; assert first-bad detection.

### Task 14: Commit search + code search

**Files:**
- Modify: `server/src/gitwork.ts`, `server/src/index.ts`, `web/src/lib/api.ts`
- Modify: `web/src/components/SearchModal.tsx` (extend the existing modal) + `web/src/lib/`

**Interfaces:**
- Produces: `searchCommits(root, query, author?, since?)` (message/SHA filter over the graph), `grepWorkingTree(root, query, { caseSensitive, wholeWord, regex })`, `searchHistory(root, query, pickaxe: "S"|"G")`.

- [ ] **Step 1: Commit filter.** Filter the existing `logGraph` output by message/SHA regex server-side or client-side; add a filter input in the Log view header (`git log --grep=... --author=...` when the panel wants precision).
- [ ] **Step 2: Grep.** `git grep -n <flags> <query>` with exit-code-1 = no matches (gitcito `git.ts:2121-2148`); results carry path:line + snippet.
- [ ] **Step 3: Pickaxe.** `git log -S<query>` (adds/removes count) and `-G<regex>` (patch match) with `--format=%H\x1f%s\x1e` — answers "which commit introduced this string".
- [ ] **Step 4: UI.** Extend `SearchModal.tsx` with three modes: commits / working tree / history; hit rows jump to the commit or file. Word-level highlight on the hit line.
- [ ] **Step 5: Tests.** Grep finds tracked + untracked; pickaxe `-S` finds the introducing commit.

### Task 15: Tags power-ups

**Files:**
- Modify: `server/src/gitwork.ts` (`tags` at `gitwork.ts:2885` area), `server/src/index.ts`, `web/src/lib/api.ts`, `web/src/components/GitPanel.tsx` (tags view)

**Interfaces:**
- Produces: `createTag(root, name, { annotated?, message?, signed? })`, `deleteTag(root, name)`, `pushTag(root, name, remote?)`, `deleteRemoteTag(root, name, remote?)`.

- [ ] **Step 1: Create.** Lightweight default; annotated adds `-a -m`; signed adds `-s`. Refuse names that already exist (`tag --list` check).
- [ ] **Step 2: Push/delete.** `push <remote> <name>` and `push <remote> :refs/tags/<name>` for remote delete.
- [ ] **Step 3: Tests.** Annotated round-trips its message; delete refuses to touch a tag you don't own locally (`-d` semantics).

---

## Out of scope (deliberate)

- **Stacked branches / restack** — worktrees + Tasks→PR already cover the workflow; a restack cascade earns less than the in-scope history tools. Revisit if asked.
- **Hosting features** (PR create/review/merge, issues, milestones, releases, notifications inbox, clone-on-host) — agentglass's `prs.ts`/`issues.ts` panels already own this.
- **Inline CI status on commit rows** — the PR panel already shows check-runs; per-commit badges are cosmetic.
- **Repo groups/tabs, command-palette recents, profiles, i18n, onboarding** — product-model differences (fleet dashboard vs single-client GUI), not gaps.
- **Run & debug (`launch.json`)** — agentglass has a real terminal and editor integration instead.
- **Vault / secret store, themes, file preview, integrated terminal** — already exist in agentglass (`secretservice.ts`, 22 themes, `PeekFile`, real PTY).
- **Word-level diff, split (side-by-side) diff, line-level staging, AI commit messages, commit-message linter** — nice-to-haves; adopt only if a task-track has spare capacity (the `buildLinePatch`/`parseDiff` pieces in the Analysis table are directly stealable when we do).

---

## Execution notes

- Worktree rule (mandatory): every task-track runs in its own local `git worktree add` sibling folder; never `git push` — hand off by local branch + commit range.
- Parallelism: Tasks 1-3 are one serial track (cherry-pick flagship). Tasks 4, 5, 7, 8, 9, 11-15 are independent of each other once Task 1's patterns land — safe to parallelize after Task 3 merges to the base. Tasks 6 and 10 are pure-read and can run first if capacity allows.
- After each task: `make typecheck`; targeted `bun test`; leave `git worktree remove` cleanup to the orchestrator.
