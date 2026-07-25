# agentglass — Security Audit Report

**Target:** `dakristia/agentglass` (fork of `SirAllap/agentglass`)
**Commit audited:** `dd77fdc68432797cc4dca835b32c106db2f3795c` (branch `main`, working tree clean)
**Date:** 2026-07-20
**Auditor:** Claude Code (Opus 4.8), 4 parallel read-only subagents
**Scope:** Full source tree — `server/`, `web/`, `landing/`, `hooks/`, `npm/`, `src-tauri/`, `.github/`, build scripts
**Out of scope:** Prebuilt/published binaries, the npm-published package contents, transitive dependency source, runtime behavior (static source review only)

---

## 1. Objective / threat model

Primary question: **does agentglass covertly leak session data, auth tokens, or cookies to a third party** (e.g. the original author's server or any non-local host)? Secondary: any internet connectivity that warrants scrutiny, and any malicious install-time behavior.

This matters because agentglass ingests highly sensitive material by design — full AI-agent transcripts (prompts, tool calls, file contents), model/cost telemetry, and it reads the local Claude OAuth credential file.

## 2. Verdict

**No evidence of covert third-party exfiltration of session data, tokens, or cookies.** Every outbound network path in the codebase is either (a) to `api.anthropic.com` using the user's own credentials for its stated purpose, or (b) an explicit, off-by-default, operator-controlled switch. The code is, in several places, **deliberately hardened against exactly this threat** — including an anti-exfiltration guard in the hook scripts that names the attack it prevents.

The genuine risk in this tool is **not** upstream data leakage — it is the **powerful local attack surface** (real PTY shells, git write, Docker control, browser-driven `claude` execution). That is an operational hardening concern, addressed in §6.

**Suitability:** Safe to adopt, or to harvest components from, with respect to the data-leak concern — provided the operational hardening in §6 is applied and the source-vs-binary trust note in §5 is respected.

## 3. Methodology

Four independent read-only audits run in parallel, each enumerating every network primitive (`fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `sendBeacon`, raw sockets, `dns`/`dgram`, `reqwest`/`hyper`, process spawns of `curl`/`wget`/`nc`), tracing sensitive-data flow, and hunting for obfuscation (`eval`, `new Function`, `atob`, base64/hex blobs, dynamically-constructed hostnames, env-driven remote endpoints):

1. **Server** — `server/src/*.ts` (the real data trust boundary)
2. **Web frontend** — `web/`, `landing/`
3. **Supply chain** — `hooks/`, `npm/`, root `package.json`, `Makefile`, `.github/`
4. **Desktop** — `src-tauri/` (Rust + Tauri v2 config, CSP, capabilities)

## 4. Egress inventory (complete)

Every outbound network path found anywhere in the codebase:

| # | Location | Destination | Payload | Trigger / control | Severity |
|---|----------|-------------|---------|-------------------|----------|
| 1 | `server/src/usage.ts:65` | `api.anthropic.com/api/oauth/usage` (only hardcoded external host) | Local Claude OAuth token in one `Authorization: Bearer` header; no body | `GET /usage`, 60s cache. Token read only here, **never logged/persisted/forwarded** (traced end-to-end) | INFO |
| 2 | `server/src/walkthrough.ts:142` | `api.anthropic.com` (Anthropic SDK default base URL) | Compressed diff hunks; no tokens/cookies | Fallback only, when `ANTHROPIC_API_KEY` set **and** local `claude` CLI absent. Primary path spawns local `claude` | INFO |
| 3 | `server/src/alerts.ts:25` | `AGENTGLASS_WEBHOOK` (env var) | Short human-readable alert strings (truncated command summaries, error text) — **not** transcripts/tokens/cookies | Fires only if operator sets the env var; **no HTTP route can set or change the URL** | LOW |
| 4 | `hooks/send_event.py:104`, `gate_event.py:102` | `http://localhost:4000` (default) | **Full session content** (transcript, prompts, tool I/O) — genuinely sensitive | Endpoint override via `AGENTGLASS_SERVER` is **hard-refused unless `AGENTGLASS_ALLOW_REMOTE=1`** (see §5.3) | INFO (guarded) |
| 5 | `hooks/opencode-plugin.js:40` | `http://localhost:4000/ingest` (default) | OpenCode prompts, tool input/output, usage, and session metadata | Runtime validation hard-refuses non-local `AGENTGLASS_SERVER` values unless `AGENTGLASS_ALLOW_REMOTE=1` | INFO (guarded) |

Everything else classified as network is **inbound receivers** (`POST /ingest`, OTLP `/v1/traces`, `/v1/logs`) or **spawns of local binaries** (`git`, `docker`, `notify-send`, the local `claude` CLI, the login shell for the PTY). No raw sockets, no `dns`/`dgram`, no `curl`/`wget`/`nc` spawns.

**Not found anywhere:** analytics/telemetry SDK, error-reporting service (Sentry etc.), third-party CDN, tracking pixel/beacon, `eval`/`new Function`, base64/hex payload blobs, dynamically-built exfil hostnames, phone-home relay, Tauri auto-updater, npm `preinstall`/`prepare`, CI secret exfiltration.

## 5. Findings by area

### 5.1 Server (`server/src`) — CLEAN

- **Token flow confirmed clean.** The Claude OAuth `accessToken` is read only in `usage.ts` (from `~/.claude/.credentials.json`), lives in a local variable, is used only in the Bearer header to `api.anthropic.com`, and is never logged, cached, persisted, or forwarded. The error path stores `String(e)`, not the token.
- **Bind is loopback by default.** `index.ts:64` — `AGENTGLASS_BIND || "127.0.0.1"`. Non-loopback bind is a deliberate opt-in and, when exposed, `resolveToken` mints/requires a shared secret rather than running unauthenticated.
- **Layered request guards** run before every route: DNS-rebinding `Host` guard (parses `Host`/`Origin` as a real IP via `isIP`, so `10.evil.com` is rejected — not string-matched), CSRF origin check, optional shared-secret token, and rate-limiting on the intake sinks.
- **State-executing routes** (`/terminal/pty`, `/chat/send`, `/git/*`, `/docker/*`) are gated by a trusted-caller check plus an in-scope path check; a remote peer cannot reach them unless the operator both exposed the port and supplied token/origin.
- Only `atob` use is decoding a pasted-image base64 in chat (magic-byte validated), not code execution.

### 5.2 Web frontend (`web/`, `landing/`) — CLEAN

- All runtime traffic funnels through one constant `SERVER` (`api.ts:6`), defaulting to `http://<page-host>:4000` — same origin that served the page. No other host is contacted at runtime.
- Token handling: read from `?token=` (then stripped from the address bar) or `localStorage`, sent **only** as a Bearer header / `?token=` to `SERVER`. No `document.cookie` reads. Other localStorage use is benign UI state.
- `index.html` is clean — only local favicon and local module script. No external `<script>`, no preconnect/prefetch, no analytics.
- No `eval`/`new Function`/`atob`-decoded URLs. Dynamic `import()` appears only for bundled local modules (Tauri autostart plugin, Shiki themes served as same-origin chunks).
- `landing/` is a static page — theme engine, canvas animation, clipboard copy. No `fetch`/`WebSocket`/beacon of any kind. External references are inert social-preview meta tags and user-clicked GitHub links.

### 5.3 Supply chain (`hooks/`, `npm/`, build, CI) — CLEAN & HARDENED

- **Anti-exfiltration guard.** Every hook and plugin (`send_event.py`, `gate_event.py`, `connect_otel.py`, `seed_demo.py`, `opencode-plugin.js`) validates its destination before sending: it **hard-refuses to POST to any host other than `localhost`/`127.0.0.1`/`::1` unless `AGENTGLASS_ALLOW_REMOTE=1` is explicitly set.** The code comments name the exact threat: `AGENTGLASS_SERVER` is attacker-influenceable, and the payloads carry full session content. This is a defender's control against the precise scenario under review.
- **No install-time code execution.** Root `postinstall` just prints a hint string via `bun -e "console.log(...)"`. No `preinstall`/`prepare` anywhere. Hook installation is **opt-in** via a manual `bun run setup` - nothing modifies agent configuration on install.
- **`npx agentglass` (`npm/cli.mjs`)** is a pure ANSI console banner — downloads nothing, spawns nothing, sends nothing.
- **Installers** write only their integration files: `install_hooks.py` updates `~/.claude/settings.json` (or a project's), while `connect_opencode.py` copies a dependency-free plugin to `~/.config/opencode/plugins/agentglass.js` without changing OpenCode's package configuration. Both back up replaced files, are idempotent, and remove only their own entries on uninstall. `connect_otel.py` similarly edits Gemini/Codex configs to point at the local server, with backups.
- **CI** — `ci.yml`, `pages.yml`, `release.yml`, `desktop-binaries.yml` use only the ephemeral `github.token`, no external network calls, no secret exfiltration. `pr-template-nudge.yml` uses the risky `pull_request_target` trigger **safely** (no PR checkout, `pull-requests: write` only, reads PR body / posts a comment).

### 5.4 Desktop (`src-tauri/`) — CLEAN

- **Strict CSP** (`tauri.conf.json:24`): `connect-src` limited to `'self'` + IPC + `localhost:4000` / `127.0.0.1:4000` — no remote origin. `frame-src`/`object-src`/`base-uri`/`form-action`/`frame-ancestors` all `'none'`.
- Window loads the **bundled local** frontend (`../web/dist`); there is **no** `app.windows[].url`, so no remote URL is ever loaded.
- **No updater config exists** — the auto-update RCE path is absent entirely.
- **Capabilities** (`capabilities/default.json`): only `core:default` + autostart enable/disable/is-enabled. **No `shell:*`, `fs:*`, `http:*`, `dialog:*`, or `process:*`** — the webview cannot exec shells, touch the filesystem, or make native HTTP calls. No access to `~/.claude/.credentials.json` or `~/.ssh`.
- **Zero custom `#[tauri::command]` handlers.** `tauri-plugin-shell` is initialized but granted no permission, so it is inert as shipped (flag for future capability edits only). Rust spawns only the local sidecar server (path resolved next to the exe, no string concat/web input) and probes `127.0.0.1:4000` for liveness. No outbound request to any external host in Rust.
- `Cargo.toml`: minimal direct deps, all from crates.io (no `git+` sources). `reqwest`/`hyper` are transitive via Tauri core, not app-wired.

## 6. Residual risks & recommendations

None of these contradict the verdict; they are operational trust boundaries the operator owns.

1. **Local attack surface is the real risk — harden it.** agentglass can open real shells, write git, control Docker, and run `claude` from the browser. It binds `127.0.0.1` by default, but on a shared/multi-user host `localhost` belongs to the machine, not your account.
   - Set `AGENTGLASS_TOKEN` to lock the server to you.
   - Disable surfaces you don't need: `AGENTGLASS_TERMINAL_DISABLED=1`, `AGENTGLASS_CHAT_DISABLED=1`, `AGENTGLASS_GIT_WRITE_DISABLED=1`, `AGENTGLASS_DOCKER_WRITE_DISABLED=1`, `AGENTGLASS_FS_BROWSE_DISABLED=1`.
   - **Never** bind `0.0.0.0`. Treat the port like `sshd` on your workstation.
2. **Two operator-controlled egress switches exist — leave them off / trusted.** `AGENTGLASS_ALLOW_REMOTE=1` (lets hooks POST full transcripts off-box) and `AGENTGLASS_WEBHOOK` (alert strings). Both are off/unset by default. Do not set either to a destination you don't control. Beware a cloned project's `.claude/settings.json` trying to set `AGENTGLASS_SERVER` — the guard neutralizes it unless `ALLOW_REMOTE` is also set, but stay aware.
3. **Source-vs-binary trust.** This audit is source-only. A **prebuilt bundle** or the **published npm package** is only as trustworthy as whoever built it — `VITE_CW_SERVER` can repoint the entire frontend at an arbitrary backend at build time. **Build from the source you audited.**
4. **It's a fork — re-review on sync.** This report covers commit `dd77fdc`. When syncing upstream from `SirAllap/agentglass`, review the diff and pin to a reviewed commit rather than tracking `main` blindly. (No upstream remote is currently configured; `origin` points at the fork `dakristia/agentglass`.)
5. **Third-party GitHub Actions** are pinned to moving tags (`@stable`, `@v2`, `@v0`) rather than commit SHAs — low, common supply-chain risk. Consider SHA-pinning if you adopt the CI.

## 7. Conclusion

On the stated concern — leaking session data, tokens, or cookies to a third party — agentglass is **clean**. The only external host in the code is `api.anthropic.com` (the user's own credentials, for the plan-usage meter it advertises), and the two additional egress paths are off-by-default, operator-controlled, and cannot be flipped by any network request. The hook layer actively defends against the repo-local-config exfiltration vector. The desktop shell exposes no dangerous native capabilities and loads no remote content.

Adopt it, or extract components from it, with confidence on the data-leak axis — while applying the local-capability hardening in §6, which is where this tool's actual risk lives.
