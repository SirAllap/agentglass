# agentglass, for agents

Two things an agent meets here: the product, which gives it a browser of its
own, and the repository, which has rules that cost something the day they were
broken. The long version of each is linked; this page is the short one.

## Using the built-in browser from a session

agentglass ships a browser that is already signed in to whatever the person
using it is signed in to, and two ways to drive it:

- `agentglass-browser` — a CLI. `agentglass-browser observe --shot` is the verb
  to reach for first: one answer with the URL, the title, the console and
  network since your last look, a tree of the interactive page with stable ids
  (`e17`), and every form's values. Then `click e17`, `fill`, `type`, `press`,
  `read`, `markdown`, `extract`, `links`, `search`, `interactive`, `forms`,
  `attr` — every verb that takes a selector takes an id from an observation
  instead, so nobody invents CSS.
- `agentglass-browser-mcp` — the same verbs as MCP tools (`browser_observe`,
  `browser_click`, …), over stdio or Streamable HTTP.
- `agentglass-cockpit-mcp` — what the cockpit knows about your own work, as
  read-only MCP tools: sessions and their spend, tool latency, recent errors,
  and what is waiting on a person.

What to know before the first call, all of it in
[skills/browser-use/SKILL.md](skills/browser-use/SKILL.md):

- An id is good for the page that handed it out. After a navigation, on another
  tab, or once the node is gone, it is refused with a sentence that says which,
  and the fix is always the same: `observe` again.
- A failure explains itself — the last console errors and failed requests come
  with it — so there is no second call to make to find out what went wrong.
- Name your tab (`--as <name>`) and the relay keeps other agents' tabs out of
  your way, and yours out of theirs.
- `AGENTGLASS_BROWSER_READONLY=1` on the server refuses every acting verb and
  keeps reading, screenshots and the logs working. Where the browser may be
  sent is held at the relay (no `file:`, no `javascript:`, no link-local
  address) and again at connect time by an egress guard, so a hostname that
  resolves to the cloud metadata endpoint or flips to loopback mid-session is
  refused there. Details: [SECURITY.md](SECURITY.md).

The HTTP API the CLIs speak, and every environment variable, are in
[docs/CONFIG.md](docs/CONFIG.md). Driving agentglass from a harness of your own
is [docs/EXTENDING.md](docs/EXTENDING.md).

## Working in this repository

Layout: `server/` (Bun + SQLite, the API and the relays), `web/` (React +
Vite, the dashboard), `electron/` (the desktop shell, plain CommonJS with no
build step), `mobile/` (the Android companion), `bin/` (the CLIs),
`shared/` (types both sides import), `skills/` (what an agent reads),
`docs/` and the root `*.md` (what a person reads).
[CONTRIBUTING.md](CONTRIBUTING.md) has the dev setup;
[SECURITY.md](SECURITY.md) has where to report a vulnerability.

This file is the one set of rules for every agent that works here, whichever
tool it runs in, and any of them may improve it. `CLAUDE.md` only imports it,
because Claude Code reads AGENTS.md on its own only when no CLAUDE.md exists.

Rules that cost something the day they were broken. They are short because
each one is a scar, not a preference.

### This repository is public

Everything below follows from that one fact.

- **No private conversation ever reaches a file, a commit message, a pull
  request body, or a comment on one.** Not quoted, not translated, not
  paraphrased with "reported by". A comment owes the next reader the defect and
  how it was measured; who mentioned it, and in what words, is not
  documentation. Write "the strip did not follow the computer", never "somebody
  said the strip did not follow the computer".
- **No real names.** Not in a comment, not in an example, not in test data.
  Chat notifications and task boards carry other people's names — replace them
  with a placeholder before the example goes in.
- **No links to an assistant session.** They are private URLs and they belong
  in nobody's git history. The GitHub tooling can append one to a pull request
  body when the pull request is CREATED: after opening one, read the body back
  and strip it. Editing a body never adds one.
- **One signature per pull request body, at most.** Two is what happens when a
  footer is written by hand and appended by a tool as well.
- **Nothing in the tree that is not the change.** No design notes, no scratch
  files, no implementation plans, no screenshots of a conversation. A working
  document lives outside the repository.

`bun test` in `server/` runs `test/private-content.test.ts`, and it fails the
build rather than trusting anybody to remember. It checks two of the five:

  the session links, which are a fixed shape;
  and a quoted conversation, by language — this codebase is written in
  English, so three distinct Spanish function words inside one pair of quotes
  in a comment is not an accident. The comment is flattened first, because a
  quote wrapped across two lines is one quote to a reader.

**A real name it cannot check**, and pretending otherwise is worse than saying
so: there is no scan that separates a person from an identifier. That one rests
on whoever writes the example, and the place it has come from every time is a
chat notification or a task board open on the other screen.

The other two — a paraphrase with "reported by", and a working document
committed by accident — are the same: read before you commit, because nothing
here will stop you.

### Commits

- End the message with `Co-Authored-By:` and nothing else. No session trailer.
- One reason per commit, and the message says why rather than what — the diff
  already says what.

### Tests

- A test's fixture should be the shape of something real, and its comment
  should say what went wrong without saying who it went wrong for.
- Prefer pulling a decision out of a screen and testing it there. There is no
  renderer in this project, and a rule about source is asserted against source.

### Verify

- `make check` is the bar, never `bun test` alone: `bun test` does not
  typecheck, and a green suite with a red `tsc` has happened. `make ci` runs
  everything CI runs; `make smoke` boots the production bundle in headless
  Chrome and fails on a blank screen or a console error.
- A check that failed because of the environment (missing `node_modules`,
  no `LANG`, no `TERM`) is not a check that passed. Note it and rerun it.
- Neither is a check that SKIPPED. `bun test` exits 0 with tests it never
  ran: a fresh worktree without `mobile/node_modules` reported "586 pass,
  0 fail" out of 723 in three seconds. `make check` now prints each tranche's
  total (`tranche server: N pass, ...`) and fails a tranche that ran fewer
  than its floor in `scripts/tranche-floors.txt`, the one place those numbers
  live. A commit that adds tests may raise a floor; one that removes tests
  lowers it on purpose. Read the line, not the exit code, when it is missing.
- Before pushing, `make ci-docker`: the CI jobs in a container that is the
  runner (ubuntu 24.04, tmux 3.4, python 3.12, the bun `ci.yml` pins, Chrome,
  no `TERM`, a non-root user) on the tree as it is now. It runs every step
  and names each one that failed. `make ci` runs on this machine's tmux and
  python, which is how a commit passed here and failed there.

### Tests share one process

- `bun test` runs every file in a single process. Globals a test sets leak
  into the others: stub the minimum and restore in `afterAll`. Known leaks:
  `AGENTGLASS_ROOT`, `__setPrivateTermsPath`, anything on PATH, the scope cache,
  and a proxy variable: Bun 1.3.14 goes on using an `HTTPS_PROXY` deleted from
  `process.env`, so a function that reads one takes the env as an argument.
- `Bun.which` resolves with the PATH the process started with; changing
  `process.env.PATH` in a hook does nothing. A stub agent goes in a child
  process with the PATH already set, and the test asserts it ran against the
  stub.
- A web test that sets a global (`location`, `localStorage`, `document`, `fetch`…)
  takes it from `globalStubs()` in `web/test/stubGlobal.ts`, which gives it back
  when the file ends; `web/test/leak-guard.ts` fails the run if one is left
  behind. `bun test --seed N` also shuffles the tests inside a file, so a test
  sets up what it asserts on instead of inheriting it from the one above.
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

### Editing

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

### Before adding code

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
