# Backlog

Deferred items from the Phase 1 review cycle (2026-07-28, `REVIEW_REPORT.md`), plus follow-up work.

## Review leftovers (low priority)

| # | Item | Notes |
|---|------|-------|
| 20 | Sessions ending with only `SubagentStop` may appear live | Check whether `sessionIsLive`'s `last_seen` timeout already covers this; fix in `server/src/db.ts` / `web/src/lib/derive.ts` if not |
| 21 | Composite index LIKE limitation | `scopeClause` LIKE patterns can't use the composite indexes for prefix scans in all cases — document the limitation, revisit if scoped queries get slow |
| 23 | `<sup>` tab counts not announced by screen readers | Add `aria-label` on git panel tab counts (`web/src/components/GitPanel.tsx`) |
| 24 | Verify `claude -p` default thinking behavior | Effort dial now passes `--effort`; confirm what `claude -p` does when no flag is sent (default effort) and whether UI default of `high` matches |

## Phase 2

- **Event-loop watchdog, done properly.** Phase 1 watchdog was removed (mark/clear API never wired — it only measured timer jitter). Re-add once git operations are async, with `mark()` calls around real blocking work so it can name the culprit.
- **Async git ops.** `gitwork.ts` spawns synchronously on the request path; move to async spawns via `pool.ts`.
- **Effort per agent type.** Chat currently only spawns `claude`, so `--effort` is enough. If chat grows other backends (Codex `reasoning.effort`, opencode `reasoningEffort`), map the dial per agent — research table in `.opencode/plans/HANDOFF_review-fixes.md`.

## Security follow-ups

From the 2026-07-28 full-tree security review. The three code fixes from that review shipped on
`fix/security-hardening` (write routes on `trustedCaller`, `AGENTGLASS_ALLOW_REMOTE == "1"`,
`session_name` cap). These are the deferred items.

| # | Item | Why | Where |
|---|------|-----|-------|
| S1 | Guard the webhook destination | `AGENTGLASS_WEBHOOK` is POSTed to unvalidated — the only egress path with no local-only check, unlike every hook. At minimum log the destination once at boot so it is never silent. | `server/src/alerts.ts:26` |
| S2 | Pin the walkthrough's egress | `new Anthropic()` takes its base URL from `ANTHROPIC_BASE_URL` (SDK default), so the diff hunks we send are redirectable by env alone. Refuse a non-Anthropic base URL unless an explicit opt-in is set — same shape as `AGENTGLASS_ALLOW_REMOTE`. | `server/src/walkthrough.ts:142` |
| S3 | `AGENTGLASS_WALKTHROUGH_DISABLED=1` | The one feature that ships repo *code* to a model has no kill switch; `WALKTHROUGH_ENABLED` is derived from "is `claude` on PATH or is a key set", and only the model is configurable. Every other capability (chat, terminal, git write, docker write, fs browse) can be turned off. | `server/src/walkthrough.ts:26` |
| S4 | Pin the supply chain | Four unpinned inputs, in rough order of exposure: (a) `bunx tsc` / `bunx vite` in CI resolve and execute **latest** from npm — `cd server && bunx tsc` has no local typescript at all, so every CI run downloads a fresh one (this is also what currently crashes it locally); (b) `bun install` runs without `--frozen-lockfile`, so `bun.lock` can drift silently in CI; (c) `bun-version: latest` is an unpinned toolchain; (d) third-party actions are pinned to moving tags (`@v4`, `@v2`, `@stable`, `@v0`) rather than commit SHAs. Note `bun.lock` and `Cargo.lock` *are* committed, so local installs are reproducible — the gap is CI and the `^` ranges in every `package.json`. | `.github/workflows/*.yml`, `package.json`, `server/package.json`, `web/package.json` |

Not bugs, deliberately left as-is (documented so nobody re-litigates them):

- **Reads are open to any local process** (`/gate/pending`, `/docker/logs`, `/search`, `/export`). Setting `AGENTGLASS_TOKEN` closes them; the zero-config loopback default is the accepted trade.
- **Scope is an ergonomic boundary, not containment.** `POST /workspace` can widen it to `/`; it now needs `trustedCaller`, which is as far as it goes while the picker exists.
- **`npm/cli.mjs` still points at upstream** (`SirAllap/agentglass`) for clone URL and demo link. Fix before ever publishing from this fork.

## Pricing maintenance

- Kimi K3 rates verified 2026-07-28 ($3 in / $15 out / $0.30 cache read per MTok). Moonshot V1 sunsets 2026-08-31 — drop the fallback `kimi|moonshot` entry after that, or repoint at K2.
- `AGENTGLASS_PRICING` JSON override exists for user tuning; keep `PRICE_TABLE` match order in mind (first match wins, specific entries before broad ones).
