# Working in this repo

## Never commit on `main`

Several agent sessions run against this checkout at the same time. Committing on `main` in the shared working tree stages files another session is still editing, and rebasing to push will autostash that session's dirty tree out and back under it.

Every change starts in its own worktree and lands through a PR:

```bash
git worktree add .claude/worktrees/<name> -b <branch>
cd .claude/worktrees/<name>
# work, commit
git push -u origin <branch> && gh pr create
```

A `pre-commit` hook enforces this locally. It exempts merges, and `ALLOW_MAIN_COMMIT=1 git commit ...` is the deliberate override.

Two more consequences of the shared checkout, both worth a habit:

- Never `git add` a path you did not edit, and never `git add -A` — check `git status` first and stage your files by name.
- Delete a worktree with `git worktree remove` before deleting its branch. `git branch -d` refuses while a worktree holds the branch.

## Layout

- `web/` — the React client (Vite). `bun run build` from the repo root, or `bunx tsc --noEmit` in `web/` to typecheck.
- `server/` — the Bun server. `bun run dev` from the root runs both.
- `hooks/` — the Claude Code hook installers (`bun run setup`).

## Branch history

The repo has unrelated histories from an earlier import. Check the merge base before any rebase, and never force-push `main`.
