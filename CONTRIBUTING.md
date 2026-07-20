# Contributing to agentglass

Thanks for your interest! This project aims to stay small, fast, and
dependency-light.

## Dev setup

```bash
bun install
bun run dev          # server :4000 + UI :6180
python3 hooks/seed_demo.py   # populate with demo data
```

- **`server/`** — Bun + `bun:sqlite`. No build step; `bun --watch` reloads.
  The `gitwork.ts` / `docker.ts` adapters shell out to the `git` / `docker`
  CLIs (arg-array spawns, path/id validated) and every mutating op is
  write-gated (`AGENTGLASS_GIT_WRITE_DISABLED` / `AGENTGLASS_DOCKER_WRITE_DISABLED`).
  `terminal.ts` spawns real PTY shells (via the stdlib-only `pty_bridge.py`,
  falling back to util-linux `script`, then plain pipes) — gated by
  `AGENTGLASS_TERMINAL_DISABLED`. `transcripts.ts` scans `~/.claude/projects`
  for machine-wide history + a live tail; `config.ts` handles project scoping
  (`AGENTGLASS_ROOT` / `repoDirs`). The server binds loopback-only by default
  (`AGENTGLASS_BIND`); keep new routes behind the existing origin/CSRF gate.
- **`web/`** — React + Vite + Recharts + Shiki (diff highlighting) + xterm.js
  (the terminal panel).
  `bunx tsc --noEmit` to typecheck, `bunx vite build` to verify the production
  bundle. `bun run build:demo` builds the fabricated-data showcase.
- **`shared/types.ts`** — the event/analytics contract imported by both sides.
  Change it in one place.
- **`hooks/`** — stdlib-only Python; keep it dependency-free.
- **`electron/`** — the Electron desktop shell. It runs the `web/` UI in
  Chromium (GPU-composited) and brings the Bun server up with it. `make desktop`
  builds the UI and launches it; `make desktop-dist` packages installers with
  electron-builder (the sidecar is the Bun server compiled standalone, staged in
  via `extraResources`). Linux (AppImage/`.deb`), macOS (`.dmg`), Windows.

## Ground rules

- Match the surrounding style; keep the dependency footprint minimal.
- Typecheck must pass (`bunx tsc --noEmit` in `web/`).
- If you add a stored field, promote it to an **indexed column** in `db.ts`
  rather than leaving it buried in `payload` JSON.
- Pricing changes: edit `server/src/pricing.ts` defaults *and* mention the
  source of the numbers in the PR.

## Reporting bugs / ideas

Open an issue with repro steps (a failing `hooks/seed_demo.py` scenario is
ideal). Feature ideas welcome — describe the observability question it answers.
For open questions and setups, use
[Discussions](https://github.com/SirAllap/agentglass/discussions); for security
problems, follow [SECURITY.md](SECURITY.md) (private reporting — no public
issues, please).

## Community

Be excellent to each other — the [Code of Conduct](CODE_OF_CONDUCT.md) applies
to all project spaces.
