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

- Read [CLAUDE.md](CLAUDE.md) first. It is short, and every rule in it is a
  scar: this repository is public, so no private conversation, no real name
  and no link to an assistant session ever reaches a file, a commit message or
  a pull request.
- Layout: `server/` (Bun + SQLite, the API and the relays), `web/` (React +
  Vite, the dashboard), `electron/` (the desktop shell, plain CommonJS with no
  build step), `mobile/` (the Android companion), `bin/` (the CLIs),
  `shared/` (types both sides import), `skills/` (what an agent reads),
  `docs/` and the root `*.md` (what a person reads).
- The bar is `make check`: types and tests for server, web and mobile. A green
  `bun test` alone is not it, and a check that skipped a tranche is not one
  that passed — read the skip count. `make ci` runs everything CI runs.
- Tests share one process. Stub the minimum, restore in `afterAll`, and
  isolate anything that starts a server (`XDG_*`, `AGENTGLASS_STATE_DIR`,
  `AGENTGLASS_DB`, `TMUX_TMPDIR`). tmux in tests gets its own `-L` socket and
  is never killed without one.
- Before adding code, take the ladder in [CLAUDE.md](CLAUDE.md) — does it need
  to exist, does the repo already do it, does the platform — and stop at the
  first rung that answers. A deliberate simplification names its ceiling.
- Commits: one reason each, and the message says why. Stage by explicit path.
- [CONTRIBUTING.md](CONTRIBUTING.md) has the dev setup and the ground rules;
  [SECURITY.md](SECURITY.md) has where to report a vulnerability.
