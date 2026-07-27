# Performance Improvement Plan

This plan records the performance review validated against the codebase on
2026-07-27. Changes are intentionally split into focused commits. Broad state
management rewrites and virtualization remain profile-gated so performance work
does not unnecessarily risk behavior or responsiveness.

## Accepted Findings

| Finding | Decision |
| --- | --- |
| Terminal panes remount on dashboard renders | Implement immediately. Separate pane mounting, focus, and close callback synchronization. |
| Growing transcripts are reread and reparsed | Implement in stages, preserving parser context and incomplete records. |
| `/stats` performs repeated full-window work | Add scoped caching, linearize skill attribution, and aggregate timeline/heatmap in SQL. Keep percentiles in JavaScript initially. |
| Live events rerender most of the dashboard | Fix terminal churn first, then profile before adopting selector-based state. |
| Development mode consumes substantial memory | Treat as operational guidance; production build/start already avoids watcher overhead. |
| Terminal limits are ineffective | Enforce the global client ceiling without evicting live work. Defer an arbitrary per-repository limit. |
| Chat updates and history are unbounded | Batch streaming notifications and cap pathological output. Profile before memoization or virtualization. |
| Claude hooks start Python and forward transcripts | Stop forwarding complete transcripts first. Benchmark before adding a long-lived collector. |
| SQLite ingestion amplifies writes | Make direct ingestion atomic and return inserted rows without rereading. |
| Git and Docker subprocesses block the server | Convert request-path subprocesses to asynchronous execution with time and output bounds. |
| Polling continues while hidden and can overlap | Centralize visibility-aware polling and prevent overlapping requests. |
| Large diffs can monopolize the UI | Add explicit render limits and lower expensive highlighting thresholds before considering virtualization. |
| Shiki loads while diff panels are closed | Gate initialization on panel visibility. |
| Process and socket limits are incomplete | Add limits, backpressure, ownership, and graceful cleanup in subsystem-specific commits. |
| OpenCode emits duplicate completion events | Deduplicate by turn/message identity and bound forwarded tool output. |

## Phase 1: Immediate UI Waste

1. `fix(terminal): stop remounting panes on dashboard renders`
2. `fix(terminal): enforce the client session ceiling`
3. `perf(diff): load syntax highlighting only while open`
4. `perf(web): pause polling while the window is hidden`

## Phase 2: Ingestion Correctness and Scaling

1. `fix(transcripts): preserve incomplete JSONL records`
2. `fix(db): make event and session writes atomic`
3. `perf(db): return inserted events without rereading`
4. `fix(transcripts): checkpoint ingestion atomically`
5. `perf(transcripts): tail only appended transcript bytes`

The tail parser must retain the byte cursor, an incomplete-line buffer, tool-call
context, usage deduplication, and transcript metadata. On restart it may rebuild
state once from the existing prefix before resuming incremental reads.

## Phase 3: Stats

1. `fix(stats): scope and linearize skill attribution`
2. `perf(stats): cache summaries by complete query scope`
3. `perf(stats): aggregate timeline and heatmap in SQLite`
4. Add composite indexes only when query-plan and ingestion benchmarks justify them.

Cache identity must include normalized window, provider, and workspace. Cache
entries must be bounded, short-lived, and never expose results across scopes.

## Phase 4: Server Responsiveness

1. `perf(git): make read requests non-blocking`
2. `perf(git): make mutation requests non-blocking`
3. `perf(docker): remove synchronous request subprocesses`
4. `fix(chat): bound active processes and diagnostics`
5. `fix(server): clean up owned processes on shutdown`
6. `fix(server): handle websocket backpressure`

## Phase 5: Remaining UI and Hooks

1. `perf(chat): batch streaming store notifications`
2. `fix(opencode): emit one completion event per turn`
3. `perf(hooks): stop forwarding complete transcripts`
4. `perf(diff): limit pathological diff rendering`

## Profile-Gated Follow-ups

- Selector-based live-state store and dashboard subtree split.
- Immutable chat rows and row memoization.
- Variable-height chat virtualization.
- Diff hunk virtualization.
- Long-lived hook collector or native sender.
- Per-repository terminal cap.
- SQL percentile implementation.
- Composite indexes not supported by measured query plans.

## Verification Gates

After each phase, compare:

- Bun event-loop delay and idle CPU.
- Transcript append time as files grow.
- Cold and cached `/stats` latency.
- Ingestion latency during stats requests.
- Hidden-window request counts.
- Terminal pane mount and observer counts during live updates.
- Git and Docker request concurrency without WebSocket stalls.
- Chat render frequency and retained memory.
- Missing or duplicate transcript and completion events.

Run focused tests and typechecking throughout, the full test suite after the
implementation, and a final code review before merging.
