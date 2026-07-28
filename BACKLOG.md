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

## Pricing maintenance

- Kimi K3 rates verified 2026-07-28 ($3 in / $15 out / $0.30 cache read per MTok). Moonshot V1 sunsets 2026-08-31 — drop the fallback `kimi|moonshot` entry after that, or repoint at K2.
- `AGENTGLASS_PRICING` JSON override exists for user tuning; keep `PRICE_TABLE` match order in mind (first match wins, specific entries before broad ones).
