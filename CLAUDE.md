# Working in this repo

Facts an agent needs before touching agentglass. Long form: `CONTRIBUTING.md`, `docs/`.

## Verify

- `make check` is the bar, never `bun test` alone: `bun test` does not
  typecheck, and a green suite with a red `tsc` has happened. `make ci` runs
  everything CI runs; `make smoke` boots the production bundle in headless
  Chrome and fails on a blank screen or a console error.
- A check that failed because of the environment (missing `node_modules`,
  no `LANG`, no `TERM`) is not a check that passed. Note it and rerun it.
- Neither is a check that SKIPPED. `make check` exits 0 with tests it never
  ran, and says so only in a line nobody reads: a fresh worktree without
  `mobile/node_modules` reported "586 pass, 0 fail" out of 723 in three
  seconds. Read the skip count, not the exit code — the tranche totals are
  5250, 4320 and 721, and anything short of those is a tranche that did not
  run.
- Before pushing, emulate the CI runner (tmux 3.4, Python 3.12, no `TERM`, no `claude`, reverse file order):
  `env -u TERM PATH="<python3→3.12,tmux→/usr/bin/tmux>:$(dirname $(which bun)):/usr/bin:/bin" bun test $(ls test/*.test.ts | sort -r)`

## Tests share one process

- `bun test` runs every file in a single process. Globals a test sets leak
  into the others: stub the minimum and restore in `afterAll`. Known leaks:
  `AGENTGLASS_ROOT`, `__setPrivateTermsPath`, anything on PATH, the scope cache.
- `Bun.which` resolves with the PATH the process started with; changing
  `process.env.PATH` in a hook does nothing. A stub agent goes in a child
  process with the PATH already set, and the test asserts it ran against the
  stub.
- `bun test` writes its verdict to stderr; read both pipes with `Promise.all`.
- `beforeAll` gets 5 s by default. Servers boot with `SERVER_BOOT_MS` from
  `server/test/serverBoot.ts` as the hook's second argument.
- `expect(m).toBeDefined()` on a `match()` always passes. Use `not.toBeNull()`.
  Break every new guard on purpose and watch it go red before trusting it.
- Tests that read source as text: match `"async function foo("` with the
  paren, slice to the function's own closing brace (never a fixed window),
  strip comment lines before asserting a word is absent, and keep
  `await Bun.file(...)` at module level.
- Isolation in every test that starts the server: `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `AGENTGLASS_STATE_DIR`, `AGENTGLASS_DB`,
  `TMUX_TMPDIR`. Only `bun test` sets `NODE_ENV=test`; a `bun -e` that imports
  `db.ts` opens the real database.
- tmux in tests: `-f /dev/null`, an explicit `-L agx-<name>` socket under a
  private `TMUX_TMPDIR`, `env -u TMUX`, `sleep` as the window command, and
  `kill-server` before restoring `TMUX_TMPDIR`. Never `tmux kill-server`
  without `-L`.

## Editing

- Stage by explicit path; never `git add -A`. Other sessions may be editing
  the same tree.
- Work notes (`TASKS.md`, `DECISIONS.md`, `*_AUDIT.md`, `NOTES.md`) never go in
  the tree. Product docs live in `README.md`, `SECURITY.md`, `CONTRIBUTING.md`
  and `docs/`.
- A pre-commit hook rejects private terms. Fixtures and comments use invented
  names (`acme/orbit`, `ORBIT-1042`).
- A backtick inside a comment inside a template literal closes the literal;
  a bare `\s` in a template literal collapses to `s`.
- Replacing a block in a large file: delimit it by its own closing brace and
  check `git diff --stat` before committing.
- No dynamic `import()` between modules that already import each other; the
  bundler emits an undefined helper and the compiled server dies on line one.
- Prefer the house tokens (`ICON`/`HIT` in `web/src/lib/iconSize.ts`,
  `--surface-*` in `web/src/index.css`, `LAYER` in `web/src/lib/layers.ts`)
  over new numbers; count what the repo already uses before adding a size.

## Before adding code

A ladder. Take the rungs in order and stop at the first one that answers.

1. Does this need to exist? A thing nobody asked for is a thing somebody
   maintains.
2. Does the repo already do it? Count what is there before adding a size, a
   helper, a colour or a store — the canon is usually already written, and the
   second copy is the one that drifts.
3. Does the platform or the standard library do it?
4. Does something already installed do it? No new dependency for one function.
5. Can it be a few lines where the caller already is, instead of a module?

Then write it.

- A deliberate simplification names its ceiling. Say what the smaller thing
  cannot do — "nested groups are the next thing after this and are not here" —
  so the next person can tell a limit that was chosen from a gap that was
  missed. `simplify:` in the subject when that is the whole change.
- **The measured why is still written, and this one is not negotiable.**
  Deleting code is not deleting the paragraph that says what was measured and
  why the obvious version does not work. That paragraph is what makes this
  repo readable six months later, and it is the first thing a "shortest diff
  wins" reflex eats.
