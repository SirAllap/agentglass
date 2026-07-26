// Demo mode: the whole UI runs off fabricated-but-realistic data and a
// simulated live event stream, so agentglass can be shown on GitHub Pages
// with no server. Enabled at build time with VITE_DEMO=1.
//
// IMPORTANT: everything in this file is 100% invented. It is a fictional
// e-commerce SaaS ("Acme Shop") — apps, skills, paths, commands, diffs and
// conversations are all made up for the showcase. Do NOT put any real project,
// company, repo, skill or ticket name in here.
import type {
  WatchEvent, SessionRollup, StatsSummary, SkillInfo, FileChange, Insight,
  SearchHit, PendingGate, SessionDetail, RepoStatus, CommitResult,
  WalkthroughResult, WalkthroughInputFile, GitRepoRef, WorkingTree, GitFileChange, GitActionResult,
  GitBranch, GitCommit, GitStash, GitGraphLine, GitWorktree, DockerOverview, DockerStat, DockerActionResult,
  PrRepoId, PrSummary, PrDetail, PrThread, PrCheck, PrCheckRollup, PrCheckState, PrListResponse,
} from "../../../shared/types.ts";
import { providerOf } from "./format.ts";
import { ctxLimitOf } from "./contextWindow.ts";

export const IS_DEMO = import.meta.env.VITE_DEMO === "1";

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const rint = (lo: number, hi: number) => Math.floor(rnd(lo, hi + 1));
const uid = () => Array.from({ length: 8 }, () => "0123456789abcdef"[rint(0, 15)]).join("") + "-demo";

// A deliberately mixed fleet so the demo shows off multi-provider support:
// Anthropic + OpenAI + Google, all auto-detected from the model name.
const MODELS = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "gpt-5", "gpt-5-mini", "gemini-3-flash"];
interface Sess { app: string; sid: string; model: string }
// Fictional app suite for a made-up online store.
const SESSIONS: Sess[] = [
  { app: "shop-web", sid: "7a3f21c9-demo", model: "claude-opus-5" },
  { app: "shop-web", sid: "e2b8d640-demo", model: "gpt-5" },
  { app: "shop-api", sid: "3c9a1f52-demo", model: "claude-sonnet-5" },
  { app: "agentglass", sid: "b7e40a18-demo", model: "claude-opus-5" },
  { app: "payments-svc", sid: "5f6d2e93-demo", model: "gemini-3-flash" },
  { app: "inventory-svc", sid: "8a1c7b04-demo", model: "gpt-5-mini" },
  { app: "sandbox", sid: "d4e903a7-demo", model: "gpt-5" },
  { app: "sandbox", sid: "20f5c86b-demo", model: "claude-sonnet-5" },
];

const BASHES = [
  'cd ~/code/shop-api && rg -n "calculateTotal" src --include=*.ts',
  "git -C ~/code/shop-web diff origin/main...HEAD --stat",
  "gh pr view 482 --repo acme/shop-api --json reviewDecision,isDraft",
  "cd ~/code/shop-web && bun run build 2>&1 | grep -E 'error|built' | tail -3",
  'python3 -m pytest tests/test_cart.py -q -k "discount"',
  "docker compose up -d --build api worker",
  'grep -rn "AGENTGLASS_WEBHOOK" server/src | head',
  "terraform plan -out=plan.tfout -var-file=staging.tfvars",
];
const PATHS = [
  "/home/dev/code/shop-api/src/services/pricing.ts",
  "/home/dev/code/shop-web/src/components/Cart.tsx",
  "/home/dev/code/shop-api/src/routes/checkout.ts",
  "/home/dev/code/inventory-svc/models/product.py",
  "/home/dev/code/payments-svc/handlers/webhook.go",
];
const SKILL_NAMES = ["pr-summary", "code-review", "test-scaffold", "dep-upgrade", "changelog-gen"];

let idc = 1000;
const demoCtx = new Map<string, number>(); // session → simulated context size
// Pre events waiting for their Post. Without this the demo emitted Pres and
// Posts with unrelated tool_use_ids, so nothing ever paired: every Pre stayed
// a pulsing "Running…" row forever and no demo session could reach idle —
// the showcase demonstrating exactly the wrong behavior.
const openPres: { app: string; sid: string; model: string; tool: string; tuid: string }[] = [];
function mkEvent(o: Partial<WatchEvent> & { source_app: string; session_id: string; hook_event_type: string }): WatchEvent {
  return {
    id: ++idc,
    tool_name: null, tool_use_id: null, agent_id: null, agent_type: null,
    model_name: null, is_error: 0, error_text: null, duration_ms: null,
    input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
    cost_usd: 0, summary: null, timestamp: Date.now(), payload: {},
    ...o,
  } as WatchEvent;
}

/** One plausible event for the live stream (weighted toward tool activity). */
function nextEvent(): WatchEvent {
  // Resolve an open Pre first, most of the time — running rows should morph
  // into finished ones within a few ticks, the way the real pairing behaves.
  if (openPres.length && (Math.random() < 0.45 || openPres.length > 4)) {
    const p = openPres.shift()!;
    return mkEvent({
      source_app: p.app, session_id: p.sid, model_name: p.model, timestamp: Date.now(),
      hook_event_type: "PostToolUse", tool_name: p.tool, tool_use_id: p.tuid,
      duration_ms: rint(300, p.tool === "Bash" ? 6000 : 900),
      payload: { tool_name: p.tool },
    });
  }
  const s = pick(SESSIONS);
  const base = { source_app: s.app, session_id: s.sid, model_name: s.model, timestamp: Date.now() };
  const roll = Math.random();
  if (roll < 0.5) {
    const tool = pick(["Bash", "Read", "Edit", "Write", "Grep"]);
    const detail = tool === "Bash" ? pick(BASHES) : pick(PATHS);
    const isErr = Math.random() < 0.05;
    return mkEvent({
      ...base, hook_event_type: "PostToolUse", tool_name: tool, tool_use_id: uid(),
      duration_ms: rint(60, tool === "Bash" ? 4000 : 300),
      is_error: isErr ? 1 : 0, error_text: isErr ? "command failed: exit code 1" : null,
      payload: { tool_name: tool, tool_input: tool === "Bash" ? { command: detail } : { file_path: detail } },
    });
  }
  if (roll < 0.62) {
    const tool = pick(["Bash", "Read", "Edit"]);
    const detail = tool === "Bash" ? pick(BASHES) : pick(PATHS);
    const tuid = uid();
    openPres.push({ app: s.app, sid: s.sid, model: s.model, tool, tuid });
    return mkEvent({ ...base, hook_event_type: "PreToolUse", tool_name: tool, tool_use_id: tuid, payload: { tool_name: tool, tool_input: tool === "Bash" ? { command: detail } : { file_path: detail } } });
  }
  if (roll < 0.72) {
    // Each turn re-sends the growing conversation (mostly as cache reads), so
    // per-session context creeps up between turns and drops on "compaction" —
    // that drift toward the radar's edge and snap back is the point of it.
    //
    // The ceiling has to be the one the radar measures against, not a second
    // copy of it: this file used to carry its own model→window cascade, and
    // when `contextWindow.ts` learned that the Claude 5 family is 1M this one
    // stayed at 200k. The demo then generated up to 184k against a 1M ring, so
    // every Claude blip sat in the inner third and never drifted anywhere —
    // the one behaviour the demo exists to show.
    const limit = ctxLimitOf(s.model);
    let ctx = demoCtx.get(s.sid) ?? rint(8_000, limit * 0.5);
    ctx += rint(3_000, 14_000);
    if (ctx > limit * 0.92) ctx = rint(limit * 0.2, limit * 0.35); // compacted
    demoCtx.set(s.sid, ctx);
    const input = rint(1_000, 6_000);
    return mkEvent({
      ...base, hook_event_type: "Turn complete", cost_usd: Number(rnd(0.4, 9).toFixed(2)),
      input_tokens: input, cache_read_tokens: Math.max(0, ctx - input), output_tokens: rint(500, 6000),
    });
  }
  if (roll < 0.8) return mkEvent({ ...base, hook_event_type: "SubagentStop", agent_id: uid(), agent_type: pick(["Explore", "workflow-subagent", "general-purpose"]), cost_usd: Number(rnd(0.1, 2).toFixed(3)) });
  if (roll < 0.88) return mkEvent({ ...base, source_app: "sandbox", session_id: uid(), hook_event_type: "SessionStart" });
  if (roll < 0.95) return mkEvent({ ...base, hook_event_type: "Notification", payload: { message: "Agent is waiting for your input", notification_type: "idle_prompt" } });
  return mkEvent({ ...base, hook_event_type: "UserPromptSubmit", payload: { prompt: pick(["fix the failing discount test", "why is the webhook 500ing?", "add a retry to the checkout job", "ship it"]) } });
}

export function recent(): WatchEvent[] {
  const out: WatchEvent[] = [];
  const now = Date.now();
  for (let i = 60; i > 0; i--) { const e = nextEvent(); e.timestamp = now - i * rint(1500, 6000); out.push(e); }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

let listeners: ((e: WatchEvent) => void)[] = [];
let streamTimer: ReturnType<typeof setInterval> | null = null;
export function startStream(push: (e: WatchEvent) => void): () => void {
  listeners.push(push);
  if (!streamTimer) {
    const tick = () => listeners.forEach((l) => l(nextEvent()));
    streamTimer = setInterval(tick, 900);
  }
  return () => {
    listeners = listeners.filter((l) => l !== push);
    if (!listeners.length && streamTimer) { clearInterval(streamTimer); streamTimer = null; }
  };
}

// --- REST-shaped generators -------------------------------------------------
export function filterOptions() {
  return { source_apps: [...new Set(SESSIONS.map((s) => s.app))].sort(), hook_event_types: ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd", "Notification", "UserPromptSubmit", "Stop", "SubagentStop"], models: MODELS };
}

// Each time-range button shows a plausibly-smaller slice of the same fleet, so
// switching 15m → 7d visibly moves every number (not just the timeline).
const WINDOW_SCALE: Record<number, number> = {
  [15 * 60_000]: 0.03,
  [3_600_000]: 0.08,
  [6 * 3_600_000]: 0.25,
  [24 * 3_600_000]: 0.55,
  [7 * 86_400_000]: 1,
};

// Scope the fabricated stats to one provider so the demo dashboard responds to
// the provider filter exactly like the real (server-filtered) one does.
function scopeStats(s: StatsSummary, provider: string): StatsSummary {
  const by_model = s.by_model.filter((m) => providerOf(m.model_name) === provider);
  const base = s.by_model.reduce((a, m) => a + m.cost_usd, 0) || 1;
  const r = by_model.reduce((a, m) => a + m.cost_usd, 0) / base; // provider's share
  const apps = new Set(SESSIONS.filter((x) => providerOf(x.model) === provider).map((x) => x.app));
  const i = (n: number) => Math.max(0, Math.round(n * r));
  const c = (n: number) => Number((n * r).toFixed(2));
  return {
    ...s,
    totals: {
      events: i(s.totals.events), sessions: i(s.totals.sessions), tool_calls: i(s.totals.tool_calls),
      errors: i(s.totals.errors), cost_usd: c(s.totals.cost_usd), input_tokens: i(s.totals.input_tokens),
      output_tokens: i(s.totals.output_tokens), cache_creation_tokens: i(s.totals.cache_creation_tokens),
      cache_read_tokens: i(s.totals.cache_read_tokens),
    },
    by_model,
    tool_latency: s.tool_latency.map((t) => ({ ...t, calls: i(t.calls), errors: i(t.errors) })),
    timeline: s.timeline.map((b) => ({ ...b, events: i(b.events), errors: i(b.errors), cost_usd: Number((b.cost_usd * r).toFixed(3)), tokens: i(b.tokens) })),
    top_skills: provider === "Anthropic" ? s.top_skills : [],
    by_app: s.by_app.filter((a) => apps.has(a.source_app)),
    by_type: s.by_type.map((t) => ({ ...t, count: i(t.count) })),
    heatmap: s.heatmap.map((n) => i(n)),
  };
}

export function stats(windowMs: number, provider?: string): StatsSummary {
  const f = WINDOW_SCALE[windowMs] ?? 1;
  const si = (n: number) => Math.max(1, Math.round(n * f)); // scaled count (≥1)
  const sc = (n: number) => Number((n * f).toFixed(2)); // scaled cost
  const heatmap = Array.from({ length: 168 }, (_, k) => {
    const h = k % 24, d = Math.floor(k / 24);
    const work = h >= 9 && h <= 19 && d >= 1 && d <= 5 ? rnd(0, 30) : rnd(0, 3);
    return Math.round(work * (0.5 + Math.random()));
  });
  const buckets = Array.from({ length: 60 }, (_, i) => {
    const t = Date.now() - (60 - i) * (windowMs / 60);
    const busy = 0.15 + 0.85 * f;
    return { t, events: rint(0, Math.round(40 * busy)), errors: Math.random() < 0.1 ? rint(1, 3) : 0, cost_usd: Number(rnd(0, 12 * busy).toFixed(3)), tokens: rint(0, Math.round(60000 * busy)) };
  });
  const summary: StatsSummary = {
    totals: { events: si(12840), sessions: si(41), tool_calls: si(6210), errors: Math.round(34 * f), cost_usd: sc(4498.08), input_tokens: Math.round(9_100_000 * f), output_tokens: Math.round(640_000 * f), cache_creation_tokens: Math.round(1_200_000 * f), cache_read_tokens: Math.round(78_000_000 * f) },
    by_model: [
      { model_name: "Opus", input_tokens: Math.round(4_100_000 * f), output_tokens: Math.round(300_000 * f), cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: sc(2350.0), sessions: si(14) },
      { model_name: "GPT-5", input_tokens: Math.round(3_200_000 * f), output_tokens: Math.round(240_000 * f), cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: sc(1180.3), sessions: si(11) },
      { model_name: "Sonnet", input_tokens: Math.round(900_000 * f), output_tokens: Math.round(80_000 * f), cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: sc(430.2), sessions: si(6) },
      { model_name: "Gemini Flash", input_tokens: Math.round(2_400_000 * f), output_tokens: Math.round(180_000 * f), cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: sc(320.44), sessions: si(7) },
      { model_name: "GPT-5 mini", input_tokens: Math.round(1_800_000 * f), output_tokens: Math.round(120_000 * f), cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: sc(217.14), sessions: si(3) },
    ],
    tool_latency: [
      { tool_name: "Bash", calls: si(2179), errors: Math.round(22 * f), p50_ms: 186, p95_ms: 8630, max_ms: 21620, avg_ms: 640, total_ms: Math.round(1_394_560 * f) },
      { tool_name: "Read", calls: si(876), errors: 0, p50_ms: 117, p95_ms: 181, max_ms: 900, avg_ms: 130, total_ms: Math.round(113_880 * f) },
      { tool_name: "Edit", calls: si(421), errors: Math.round(3 * f), p50_ms: 149, p95_ms: 214, max_ms: 415, avg_ms: 160, total_ms: Math.round(67_360 * f) },
      { tool_name: "Write", calls: si(122), errors: 0, p50_ms: 139, p95_ms: 218, max_ms: 400, avg_ms: 150, total_ms: Math.round(18_300 * f) },
      { tool_name: "mcp__tracker__get_issue", calls: si(33), errors: 0, p50_ms: 813, p95_ms: 12180, max_ms: 12180, avg_ms: 1100, total_ms: Math.round(36_300 * f) },
    ],
    timeline: buckets,
    top_skills: SKILL_NAMES.map((skill, i) => ({ skill, calls: si(8 - i), cost_usd: sc(rnd(90, 820)), last_used: Date.now() - i * 3_600_000, buckets: Array.from({ length: 12 }, () => rint(0, 3)) })),
    by_app: [...new Set(SESSIONS.map((s) => s.app))].map((app, i) => ({ source_app: app, events: si(rint(80, 1600)), sessions: si(rint(1, 14)), tool_calls: si(rint(20, 700)), cost_usd: sc(rnd(5, 3100 - i * 300)), tokens: Math.round(rint(40_000, 10_000_000) * f) })).sort((a, b) => b.cost_usd - a.cost_usd),
    by_type: [["PreToolUse", 4069], ["PostToolUse", 4057], ["SessionStart", 1402], ["UserPromptSubmit", 436], ["Stop", 395], ["SubagentStop", 336], ["Notification", 216], ["SessionEnd", 42]].map(([hook_event_type, count]) => ({ hook_event_type: hook_event_type as string, count: si(count as number) })),
    heatmap,
    window_ms: windowMs,
  };
  return provider ? scopeStats(summary, provider) : summary;
}

export function sessions(provider?: string): SessionRollup[] {
  const now = Date.now();
  return SESSIONS.filter((s) => !provider || providerOf(s.model) === provider).map((s, i) => ({
    session_id: s.sid, source_app: s.app, model_name: s.model,
    started_at: now - rint(20, 180) * 60_000, ended_at: i % 3 === 0 ? null : now - rint(1, 20) * 60_000,
    last_seen: now - rint(0, 10) * 60_000, event_count: rint(20, 900), tool_count: rint(10, 500),
    error_count: rint(0, 6), input_tokens: rint(50_000, 1_500_000), output_tokens: rint(5000, 120_000),
    cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: Number(rnd(0, 600).toFixed(2)),
  }));
}

export function skills(): { skills: SkillInfo[]; generated_at: number } {
  const defs: [string, string, string, string][] = [
    ["pr-summary", "PRs & review", "Draft a pull request title and body by summarizing the staged diff.", "Use when the user says \"open PR\", \"summarize my changes\" or \"ship it\""],
    ["code-review", "PRs & review", "Second-pass review of a diff — flag risky changes, missing tests and edge cases.", "Use when the user asks for a review or before merging"],
    ["test-scaffold", "testing & QA", "Scaffold unit tests for a module with realistic fixtures and edge cases.", "Use when a file has little or no test coverage"],
    ["systematic-debugging", "dev workflow", "A disciplined bisect-and-hypothesize loop for gnarly bugs.", "Use when a bug resists the first two obvious fixes"],
    ["deploy-guide", "release & ops", "Guided staging → production deploy with rollback checkpoints.", "Use when the user says \"deploy\" or \"ship to prod\""],
    ["dep-upgrade", "dev workflow", "Bump dependencies safely and surface breaking changes from release notes.", "Use when the user says \"upgrade deps\" or a bot opens a bump PR"],
    ["test-harness-html", "testing & QA", "Generate a single-file interactive HTML harness to verify a feature locally.", "Use when a change needs manual local verification before PR"],
    ["worktree", "dev workflow", "Manage git worktrees with project scripts.", "Use when the user says \"create worktree\" or \"switch worktree\""],
    ["changelog-gen", "release & ops", "Generate a changelog entry from merged commits since the last tag.", "Use when cutting a release"],
    ["api-docs", "backend", "Generate OpenAPI docs from route handlers.", "Use when adding or changing an endpoint"],
  ];
  const now = Date.now();
  return {
    generated_at: now,
    skills: defs.map(([name, category, description, when_to_use], i) => ({
      name, kind: i % 4 === 0 ? "command" : "skill", description, argument_hint: null,
      source: pick(["shop-api", "user"]), copies: rint(1, 17), path: `~/code/shop-api/.claude/skills/${name}/SKILL.md`,
      added: now - rint(6, 110) * 86400_000, calls: Math.max(0, 10 - i * 2 + rint(-1, 1)),
      last_used: i < 6 ? now - i * 3600_000 : null, cost_usd: i < 6 ? Number(rnd(10, 250).toFixed(2)) : 0,
      category, when_to_use,
    })) as SkillInfo[],
  };
}

const DIFF: FileChange["hunks"] = [{ oldStart: 42, oldLines: 4, newStart: 42, newLines: 7, lines: [" function calculateTotal(cart) {", "-  const subtotal = cart.items.reduce((s, i) => s + i.price, 0);", "-  return applyCoupon(subtotal, cart.coupon);", "+  const subtotal = cart.items.reduce((s, i) => s + i.price * i.qty, 0);", "+  const discount = cart.coupon ? applyCoupon(subtotal, cart.coupon) : 0;", "+  return Math.max(0, subtotal - discount);", "+}", " "] }];
export function changes(): { changes: FileChange[] } {
  const now = Date.now();
  return { changes: Array.from({ length: 24 }, (_, i) => ({ id: 9000 - i, timestamp: now - i * 90_000, source_app: pick(SESSIONS).app, session_id: pick(SESSIONS).sid, tool: i % 5 === 0 ? "Write" : "Edit", file_path: pick(PATHS), additions: rint(1, 40), deletions: rint(0, 12), hunks: DIFF })) };
}

export function gitStatus(): { repos: RepoStatus[]; commitEnabled: boolean } {
  return {
    commitEnabled: true,
    repos: [{
      root: "/home/you/code/shop-api",
      branch: "main",
      files: [
        { path: "src/pay.ts", code: " M", staged: false, unstaged: true, status: "modified" },
        { path: "src/cart.ts", code: " M", staged: false, unstaged: true, status: "modified" },
        { path: "src/checkout/index.ts", code: "??", staged: false, unstaged: true, status: "untracked" },
        { path: "test/pay.test.ts", code: " M", staged: false, unstaged: true, status: "modified" },
      ],
      suggested: ["src/pay.ts", "src/cart.ts", "src/checkout/index.ts"],
    }],
  };
}
export function gitCommit(): CommitResult {
  return { ok: true, sha: "9f2c1a7b3e4d5f60718293a4b5c6d7e8f9012345", shortSha: "9f2c1a7b", summary: "3 files, +40 −5" };
}

// --- live git panel (demo is read-only) ---
export function gitRepos(): { repos: GitRepoRef[] } {
  return { repos: [
    // Fixed stamps, not Date.now(): a demo that reorders itself between two
    // screenshots is a demo that looks broken.
    { root: "/home/you/code/shop-api", name: "shop-api", branch: "main", dirty: 3, ahead: 2, behind: 0, touchedAt: 1_760_000_000_000 },
    { root: "/home/you/code/agentglass", name: "agentglass", branch: "feat/git-panel", dirty: 1, ahead: 0, behind: 1, touchedAt: 1_759_000_000_000 },
  ] };
}
function gcf(id: number, path: string, status: GitFileChange["status"], staged: boolean, lines: string[]): GitFileChange {
  return {
    id, timestamp: Date.now(), source_app: "git", session_id: staged ? "staged" : "unstaged", tool: "git",
    file_path: "/home/you/code/shop-api/" + path,
    additions: lines.filter((l) => l[0] === "+").length,
    deletions: lines.filter((l) => l[0] === "-").length,
    status, staged, binary: false,
    hunks: [{ oldStart: 1, oldLines: lines.filter((l) => l[0] !== "+").length, newStart: 1, newLines: lines.filter((l) => l[0] !== "-").length, lines }],
  };
}
export function gitTree(root: string): WorkingTree {
  return {
    root: root || "/home/you/code/shop-api",
    branch: { name: "main", upstream: "origin/main", ahead: 2, behind: 0, detached: false },
    staged: [gcf(1, "src/pay.ts", "modified", true, [" export function pay(cart: Cart) {", "-  return cart.total;", "+  return Math.max(0, cart.total);", " }"])],
    unstaged: [
      gcf(2, "src/cart.ts", "modified", false, [" function total(cart) {", "-  return cart.items.reduce((a, i) => a + i.price, 0);", "+  return cart.items.reduce((a, i) => a + i.price * i.qty, 0);", " }"]),
      gcf(3, "src/checkout/index.ts", "untracked", false, ["+export function checkout() {", "+  return true;", "+}"]),
    ],
    clean: false, writeEnabled: false,
  };
}
export function gitActionUnavailable(): GitActionResult {
  return { ok: false, error: "git actions are disabled in the demo" };
}
export function gitBranches(): { current: string; branches: GitBranch[] } {
  return { current: "feat/git-panel", branches: [
    { name: "feat/git-panel", current: true, upstream: null, track: "", date: "2 hours ago", subject: "wip: source control panel" },
    { name: "main", current: false, upstream: "origin/main", track: "[behind 3]", date: "1 day ago", subject: "checkout hardening" },
    { name: "develop", current: false, upstream: "origin/develop", track: "[ahead 1, behind 5]", date: "3 days ago", subject: "merge feature branches" },
  ] };
}
export function gitGraph(): { lines: GitGraphLine[] } {
  const c = (graph: string, hash: string, subject: string, refs = ""): GitGraphLine => ({ graph, hash, author: "David", date: "2h", subject, refs });
  return { lines: [
    c("* ", "9f2c1a7", "checkout hardening: qty-aware totals", "HEAD -> feat/git-panel"),
    c("* ", "3b7d0e2", "fix: guard empty coupon so it can't double-discount"),
    { graph: "|\\ " },
    c("| * ", "a1c9f34", "refactor: extract the discount helper", "origin/main, main"),
    c("* | ", "7e0b512", "test: cover the duplicate-coupon edge case"),
    { graph: "|/ " },
    c("* ", "c40d918", "feat: wire the new checkout route into the router", "tag: v1.2.0"),
  ] };
}
export function gitWorktrees(): { worktrees: GitWorktree[] } {
  return { worktrees: [
    { path: "/home/you/code/shop-api", branch: "main", head: "9f2c1a7", current: true, bare: false, locked: false },
    { path: "/home/you/code/shop-api-PROJ-42", branch: "feat/PROJ-42-callbacks", head: "3b7d0e2", current: false, bare: false, locked: false },
    { path: "/home/you/code/shop-api-hotfix", branch: "hotfix/cache-ttl", head: "a1c9f34", current: false, bare: false, locked: true },
  ] };
}
export function gitLog(): { commits: GitCommit[] } {
  const c = (h: string, s: string, d: string, refs = ""): GitCommit => ({ hash: h + "0000000000000000000000000000000000", shortHash: h, subject: s, author: "David", date: d, refs });
  return { commits: [
    c("9f2c1a7", "checkout hardening: qty-aware totals", "2 hours ago", "HEAD -> feat/git-panel"),
    c("3b7d0e2", "fix: guard empty coupon so it can't double-discount", "5 hours ago"),
    c("a1c9f34", "refactor: extract the discount calculation helper", "1 day ago"),
    c("7e0b512", "test: cover the duplicate-coupon edge case", "2 days ago"),
    c("c40d918", "feat: wire the new checkout route into the router", "3 days ago", "tag: v1.2.0"),
  ] };
}
export function gitCommitDiff(_hash: string): { changes: FileChange[] } {
  return { changes: [{
    id: 1, timestamp: Date.now(), source_app: "git", session_id: "commit", tool: "git",
    file_path: "/home/you/code/shop-api/src/pay.ts", additions: 2, deletions: 1,
    hunks: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [" function pay(cart: Cart) {", "-  return cart.total;", "+  const t = Math.max(0, cart.total);", "+  return t;", " }"] }],
  }] };
}
export function gitStashes(): { stashes: GitStash[] } {
  return { stashes: [
    { index: 0, ref: "stash@{0}", message: "WIP on feat/git-panel: experiment with split view" },
    { index: 1, ref: "stash@{1}", message: "On main: quick spike" },
  ] };
}

// --- docker panel (demo is read-only) ---
export function dockerOverview(): DockerOverview {
  const c = (id: string, name: string, image: string, state: string, status: string, service: string, ports = "") =>
    ({ id, name, image, state, status, ports, project: "shop", service, runningFor: status, size: "" });
  return {
    available: true, writeEnabled: false, version: "27.0.3",
    containers: [
      c("a1b2c3d4e5f6", "shop-api", "shop-api:dev", "running", "Up 3 hours", "api", "0.0.0.0:8080->8080/tcp"),
      c("b2c3d4e5f6a7", "shop-worker", "shop-api:dev", "running", "Up 3 hours", "worker"),
      c("c3d4e5f6a7b8", "shop-postgres", "postgres:16", "running", "Up 3 hours (healthy)", "postgres", "5432/tcp"),
      c("d4e5f6a7b8c9", "shop-redis", "redis:7", "running", "Up 3 hours", "redis"),
      c("e5f6a7b8c9d0", "shop-migrate", "shop-api:dev", "exited", "Exited (0) 3 hours ago", "migrate"),
    ],
    images: [
      { id: "4cc9938d5ef2", repository: "shop-api", tag: "dev", size: "612MB", created: "3 hours ago", containers: "3", dangling: false },
      { id: "9f2c1a7b3e4d", repository: "postgres", tag: "16", size: "431MB", created: "2 weeks ago", containers: "1", dangling: false },
      { id: "1a2b3c4d5e6f", repository: "redis", tag: "7", size: "138MB", created: "3 weeks ago", containers: "1", dangling: false },
    ],
    volumes: [{ name: "shop_pgdata", driver: "local" }, { name: "shop_redisdata", driver: "local" }],
    networks: [{ id: "aa11bb22cc33", name: "shop_default", driver: "bridge", scope: "local" }],
  };
}
export function dockerStats(): { stats: DockerStat[] } {
  return { stats: [
    { id: "a1b2c3d4e5f6", cpu: 2.4, mem: 4.1, memUsage: "512MiB / 12GiB", netIO: "12MB / 8MB", blockIO: "3MB / 1MB", pids: 24 },
    { id: "b2c3d4e5f6a7", cpu: 0.8, mem: 2.2, memUsage: "268MiB / 12GiB", netIO: "4MB / 2MB", blockIO: "1MB / 0B", pids: 12 },
    { id: "c3d4e5f6a7b8", cpu: 0.3, mem: 1.5, memUsage: "182MiB / 12GiB", netIO: "1MB / 1MB", blockIO: "8MB / 4MB", pids: 9 },
    { id: "d4e5f6a7b8c9", cpu: 0.1, mem: 0.4, memUsage: "48MiB / 12GiB", netIO: "0.5MB / 0.3MB", blockIO: "0B / 0B", pids: 5 },
  ] };
}
export function dockerLogs(id: string): { ok: boolean; text: string } {
  const now = "2026-07-17T14:31:";
  return { ok: true, text: [
    `${now}20.001Z [info] ${id.slice(0, 12)} starting up`,
    `${now}21.114Z [info] connected to postgres:5432`,
    `${now}22.340Z GET /api/products 200 12ms`,
    `${now}23.902Z POST /api/cart 201 34ms`,
    `${now}25.118Z GET /api/health 200 1ms`,
  ].join("\n") };
}
export function dockerActionUnavailable(): DockerActionResult {
  return { ok: false, error: "docker actions are disabled in the demo" };
}

const DEMO_DESCS = [
  "Make cart totals quantity-aware so multi-unit line items price correctly.",
  "Guard coupon application so an empty coupon no longer double-discounts.",
  "Clamp the final total to zero to avoid negative order amounts.",
  "Extract the discount calculation into a pure, testable helper.",
  "Add regression coverage for the duplicate-coupon edge case.",
  "Wire the new checkout route into the client-side router.",
  "Tighten the env accessor so a missing SERVER_URL fails fast.",
];
const DEMO_TAGS = ["feature", "fix", "fix", "refactor", "test", "feature", "config"];
export function walkthrough(files: WalkthroughInputFile[]): WalkthroughResult {
  return {
    available: true,
    reviewFocus: "Checkout hardening: qty-aware totals, no double coupons, safe rounding.",
    files: (files ?? []).slice(0, 40).map((f, i) => ({
      path: f.path,
      description: DEMO_DESCS[i % DEMO_DESCS.length],
      tag: DEMO_TAGS[i % DEMO_TAGS.length],
    })),
  };
}

export function insights(): { insights: Insight[] } {
  return { insights: [
    { id: "loop1", severity: "warn", kind: "loop", title: "Possible loop · 41× identical command", detail: "gh pr view 482 --repo acme/shop-api --json body", session: "shop-api:3c9a1f52", ts: Date.now() - 40_000 },
    { id: "spend1", severity: "bad", kind: "spend", title: "Burning fast · $88.30 in 15m", detail: "this session is spending quickly", session: "shop-web:7a3f21c9", ts: Date.now() - 120_000 },
    { id: "burn", severity: "info", kind: "burn", title: "Spend velocity · $91.65/hr", detail: "281k tokens in the last hour", session: null, ts: Date.now() },
  ] };
}

export function search(q: string): { hits: SearchHit[] } {
  if (!q.trim()) return { hits: [] };
  const now = Date.now();
  return { hits: Array.from({ length: 12 }, (_, i) => {
    const s = pick(SESSIONS);
    const cmd = pick(BASHES);
    const hi = cmd.replace(new RegExp(q, "ig"), (m) => `${m}`);
    return { id: 8000 - i, timestamp: now - i * 60_000, source_app: s.app, session_id: s.sid, hook_event_type: i % 2 ? "PostToolUse" : "PreToolUse", tool_name: "Bash", cost_usd: 0, duration_ms: rint(60, 900), snippet: `${s.app} · Bash · ${hi}` };
  }) };
}

export function session(id: string): SessionDetail {
  const s = SESSIONS.find((x) => x.sid === id) ?? SESSIONS[0];
  const now = Date.now();
  return {
    session_id: s.sid, source_app: s.app, model_name: s.model, started_at: now - 2 * 3600_000, ended_at: null, last_seen: now - 20_000,
    events: 1038, tools: 496, errors: 3, cost_usd: 544.8, input_tokens: 1_020_000, output_tokens: 84_000,
    summary: "Fixed the cart total double-applying coupons, added a retry to the checkout webhook, and opened PR #482. All checks green.",
    tool_mix: [["Edit", 213], ["Bash", 103], ["Read", 80], ["TaskUpdate", 38], ["Write", 32], ["Skill", 8]].map(([tool, n]) => ({ tool: tool as string, n: n as number })),
    subagents: Array.from({ length: 6 }, () => ({ agent_id: uid(), agent_type: pick(["Explore", "workflow-subagent", "general-purpose"]), events: rint(4, 40) })),
    conversation: [
      { role: "user", text: "the cart total is applying the discount twice at checkout, fix it", ts: now - 90 * 60_000 },
      { role: "assistant", text: "Found it — `calculateTotal` applied the coupon and `checkout()` applied it again. Consolidating it into one place and clamping the total at zero.", ts: now - 78 * 60_000 },
      { role: "user", text: "add a retry to the checkout webhook too", ts: now - 40 * 60_000 },
      { role: "assistant", text: "Done. Wrapped the webhook call in the standard retry policy (3 attempts, exponential backoff) and opened PR #482.", ts: now - 12 * 60_000 },
    ],
    // The demo's timeline shows what the real one is for: the tool runs between
    // the messages, which is where the work actually happens.
    timeline: [
      { kind: "message", role: "user", text: "the cart total is applying the discount twice at checkout, fix it", ts: now - 90 * 60_000 },
      { kind: "tool", tool: "Grep", target: "calculateTotal", ts: now - 89 * 60_000, duration_ms: 120 },
      { kind: "tool", tool: "Read", target: "src/cart/total.ts", ts: now - 88 * 60_000, duration_ms: 90 },
      { kind: "tool", tool: "Edit", target: "src/cart/total.ts", ts: now - 80 * 60_000, duration_ms: 210 },
      { kind: "tool", tool: "Bash", target: "npm test -- cart", note: "run the cart suite", ts: now - 79 * 60_000, duration_ms: 8400 },
      { kind: "message", role: "assistant", text: "Found it — `calculateTotal` applied the coupon and `checkout()` applied it again. Consolidating it into one place and clamping the total at zero.", ts: now - 78 * 60_000 },
      { kind: "message", role: "user", text: "add a retry to the checkout webhook too", ts: now - 40 * 60_000 },
      { kind: "tool", tool: "Edit", target: "src/checkout/webhook.ts", ts: now - 30 * 60_000, duration_ms: 180 },
      { kind: "tool", tool: "Bash", target: "npm test -- checkout", ts: now - 26 * 60_000, is_error: true, duration_ms: 6100 },
      { kind: "tool", tool: "Edit", target: "src/checkout/webhook.ts", ts: now - 22 * 60_000, duration_ms: 160 },
      { kind: "tool", tool: "Bash", target: "gh pr create --fill", ts: now - 13 * 60_000, duration_ms: 2400 },
      { kind: "message", role: "assistant", text: "Done. Wrapped the webhook call in the standard retry policy (3 attempts, exponential backoff) and opened PR #482.", ts: now - 12 * 60_000 },
    ],
    changes: changes().changes.slice(0, 6),
  };
}

export function usage() {
  return { available: true, five_hour: { utilization: 34, remaining: 66, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() }, seven_day: { utilization: 61, remaining: 39, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() }, fetched_at: Date.now() };
}

// --- exports: real downloadable files, generated in-browser (no server) -----
const dataUri = (mime: string, body: string) => `data:${mime};charset=utf-8,${encodeURIComponent(body)}`;

export function eventsExportUri(fmt: "csv" | "json"): string {
  const evs = recent();
  if (fmt === "json") return dataUri("application/json", JSON.stringify(evs, null, 2));
  const cols = ["id", "timestamp", "source_app", "session_id", "hook_event_type", "tool_name", "model_name", "duration_ms", "cost_usd", "input_tokens", "output_tokens", "is_error"];
  const cell = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = evs.map((e) => cols.map((c) => cell((e as unknown as Record<string, unknown>)[c])).join(","));
  return dataUri("text/csv", [cols.join(","), ...rows].join("\n"));
}

export function skillsExportUri(): string {
  const { skills: list } = skills();
  const out = ["# Skills catalog", "", `_${list.length} skills · agentglass demo (sample data)_`, ""];
  for (const s of list) {
    out.push(`## \`${s.name}\` · ${s.kind}`, "", s.description, "");
    if (s.when_to_use) out.push(`**When to use:** ${s.when_to_use}`, "");
    out.push(`- category: ${s.category} · runs: ${s.calls} · attributed cost: $${s.cost_usd.toFixed(2)}`, "");
  }
  return dataUri("text/markdown", out.join("\n"));
}

// --- interactive control-plane gate ----------------------------------------
let gates: PendingGate[] = [];
function spawnGate() {
  gates.push({ id: uid(), source_app: pick(SESSIONS).app, session_id: pick(SESSIONS).sid, tool_name: "Bash", summary: pick(["git push --force origin main", "rm -rf ./dist ./node_modules", "psql -c 'DROP TABLE sessions;'", "kubectl delete deploy api --namespace prod"]), created: Date.now() });
  if (gates.length > 3) gates = gates.slice(-3);
}
if (IS_DEMO) { spawnGate(); setInterval(() => { if (gates.length < 2) spawnGate(); }, 18_000); }
export function gatePending(): { gates: PendingGate[] } { return { gates: [...gates] }; }
export function gateDecide(id: string): { ok: boolean } { gates = gates.filter((g) => g.id !== id); return { ok: true }; }

/* ══════════════════════════════════════════════════════════════════════
   PULL REQUESTS.

   The panel used to answer `available: false` here, so the one feature the
   landing page calls out as new — reviewing a pull request without opening a
   browser — was invisible in the demo that same page links to. Someone who
   clicked through to see it found a dead panel.

   These seven are fabricated to light up every state the panel can draw, not
   to look plausible in aggregate: between them they cover all three review
   decisions, every merge state worth explaining, checks green / red / pending,
   a draft, a bot author, a stale review after a force-push, a PR you wrote
   yourself (which GitHub will not let you review, and neither does the panel),
   the branch you happen to be standing on, threads resolved and outdated and
   live, and a 46KB coverage comment reduced to its three numbers.

   Everything is invented, in the same fictional "Acme Shop" universe as the
   rest of this file. Fixed timestamps rather than Date.now(): a demo that
   reorders itself between two screenshots is a demo that looks broken.
   ══════════════════════════════════════════════════════════════════════ */
const PR_REPO: PrRepoId = {
  key: "github.com/acme/shop-api", host: "github.com",
  owner: "acme", name: "shop-api", nameWithOwner: "acme/shop-api",
};
/** The fixture's clock is "now", so a pull request reads as "2h ago" rather
 *  than as four months stale. The offsets below are relative, so the order of
 *  the list is fixed even though the timestamps are not. */
const PR_NOW = Date.now();
const ago = (mins: number) => new Date(PR_NOW - mins * 60_000).toISOString();

function rollup(p: { ok?: number; bad?: string[]; pending?: number; skipped?: number; workflow?: string }): PrCheckRollup {
  const wf = p.workflow ?? "CI";
  const failing: PrCheck[] = (p.bad ?? []).map((name) => ({ name, workflow: wf, state: "failure", done: true }));
  const success = p.ok ?? 0, pending = p.pending ?? 0, skipped = p.skipped ?? 0;
  const total = success + failing.length + pending + skipped;
  const allDone = pending === 0;
  return {
    total, success, failure: failing.length, skipped, pending, allDone,
    verdict: allDone ? (failing.length ? "red" : "green") : null,
    failing,
  };
}
const chk = (name: string, state: PrCheckState, workflow = "CI"): PrCheck =>
  ({ name, workflow, state, done: state !== "pending" });

const PR_SUMMARIES: PrSummary[] = [
  {
    number: 482, title: "Round prices at the cart boundary, not per line",
    author: "rmoreno", state: "OPEN", isDraft: false,
    headRefName: "fix/rounding-boundary", baseRefName: "main",
    url: "https://github.com/acme/shop-api/pull/482", updatedAt: ago(118),
    reviewDecision: "REVIEW_REQUIRED", additions: 84, deletions: 31, changedFiles: 6,
    labels: [{ name: "bug", color: "d73a4a" }, { name: "pricing", color: "0e8a16" }],
    assignees: ["rmoreno"], milestone: "Q2 · checkout",
    checks: rollup({ ok: 3, bad: ["e2e (checkout)"], skipped: 1 }), checksLoaded: true,
  },
  {
    number: 479, title: "Cache the price table per request",
    author: "jkwan", state: "OPEN", isDraft: false,
    headRefName: "perf/price-cache", baseRefName: "main",
    url: "https://github.com/acme/shop-api/pull/479", updatedAt: ago(54),
    reviewDecision: "APPROVED", additions: 41, deletions: 12, changedFiles: 3,
    labels: [{ name: "performance", color: "1d76db" }],
    assignees: ["jkwan"], milestone: "Q2 · checkout",
    checks: rollup({ ok: 5 }), checksLoaded: true,
  },
  {
    number: 476, title: "Bump bun to 1.1.38",
    author: "acme-bot", state: "OPEN", isDraft: false,
    headRefName: "deps/bun-1.1.38", baseRefName: "main",
    url: "https://github.com/acme/shop-api/pull/476", updatedAt: ago(31),
    reviewDecision: null, additions: 4, deletions: 4, changedFiles: 2,
    labels: [{ name: "dependencies", color: "0366d6" }],
    assignees: [], milestone: null,
    checks: rollup({ ok: 5 }), checksLoaded: true,
  },
  {
    number: 471, title: "Otel spans around the approval gate",
    author: "t-okafor", state: "OPEN", isDraft: true,
    headRefName: "feat/gate-spans", baseRefName: "main",
    url: "https://github.com/acme/shop-api/pull/471", updatedAt: ago(9),
    reviewDecision: null, additions: 212, deletions: 8, changedFiles: 11,
    labels: [{ name: "observability", color: "5319e7" }],
    assignees: ["t-okafor"], milestone: null,
    checks: rollup({ ok: 2, pending: 3 }), checksLoaded: true,
  },
  {
    number: 468, title: "Stabilise the checkout test under load",
    author: "jkwan", state: "OPEN", isDraft: false,
    headRefName: "test/checkout-flake", baseRefName: "main",
    url: "https://github.com/acme/shop-api/pull/468", updatedAt: ago(260),
    reviewDecision: "CHANGES_REQUESTED", additions: 63, deletions: 44, changedFiles: 4,
    labels: [{ name: "flaky", color: "fbca04" }, { name: "tests", color: "c2e0c6" }],
    assignees: ["jkwan"], milestone: "Q2 · checkout",
    checks: rollup({ ok: 2, bad: ["integration (postgres)"], skipped: 1 }), checksLoaded: true,
  },
  {
    number: 465, title: "Retry the charge before failing the order",
    author: "you", state: "OPEN", isDraft: false,
    headRefName: "fix/charge-retry", baseRefName: "main",
    url: "https://github.com/acme/shop-api/pull/465", updatedAt: ago(400),
    reviewDecision: "REVIEW_REQUIRED", additions: 96, deletions: 18, changedFiles: 5,
    labels: [{ name: "payments", color: "d4c5f9" }],
    assignees: ["you"], milestone: "Q2 · checkout",
    checks: rollup({ ok: 4, skipped: 1 }), checksLoaded: true,
    isCurrentBranch: true,
  },
  {
    number: 461, title: "Drop the legacy coupon table",
    author: "t-okafor", state: "OPEN", isDraft: false,
    headRefName: "chore/drop-coupons-v1", baseRefName: "main",
    url: "https://github.com/acme/shop-api/pull/461", updatedAt: ago(1_450),
    reviewDecision: "APPROVED", additions: 9, deletions: 604, changedFiles: 8,
    labels: [{ name: "cleanup", color: "bfd4f2" }],
    assignees: ["t-okafor"], milestone: null,
    checks: rollup({ ok: 5 }), checksLoaded: true,
  },
];

/** #482 in full: the one the panel was built for. A human wants a change, a
 *  bot wrote 46KB nobody will read, one thread is already settled and another
 *  points at code that has since moved, and one check is red with a name. */
const PR_482_THREADS: PrThread[] = [
  {
    id: "PRRT_demo482a", path: "src/services/pricing.ts", line: 61,
    isResolved: false, isOutdated: false, originalLine: 61,
    url: "https://github.com/acme/shop-api/pull/482#discussion_r1",
    diffHunk: "@@ -58,6 +58,9 @@ export function cartTotal(cart: Cart) {\n   const subtotal = cart.items.reduce((s, i) => s + i.price * i.qty, 0);\n+  assertRounded(subtotal);\n   const discount = cart.coupon ? applyCoupon(subtotal, cart.coupon) : 0;",
    comments: [
      {
        id: "IC_demo1", databaseId: 90001, author: "rmoreno", isBot: false, createdAt: ago(118),
        body: "Rounding at the boundary is the right call. But `assertRounded` throws on legacy carts written before the migration — we still have ~2k of them in `orders_2024`. Can we guard it, or backfill first?",
      },
      {
        id: "IC_demo2", databaseId: 90002, author: "jkwan", isBot: false, createdAt: ago(96),
        body: "Backfill is a 40-minute job on prod. I'd rather guard and drop the guard next release.",
      },
    ],
  },
  {
    id: "PRRT_demo482b", path: "src/routes/checkout.ts", line: null,
    isResolved: false, isOutdated: true, originalLine: 118,
    url: "https://github.com/acme/shop-api/pull/482#discussion_r2",
    diffHunk: "@@ -115,7 +115,7 @@ router.post('/checkout', async (req, res) => {\n-  const total = cartTotal(cart);\n+  const total = round2(cartTotal(cart));",
    comments: [{
      id: "IC_demo3", databaseId: 90003, author: "t-okafor", isBot: false, createdAt: ago(300),
      body: "Double rounding here — `cartTotal` already rounds now.",
    }],
  },
  {
    id: "PRRT_demo482c", path: "src/services/pricing.ts", line: 12,
    isResolved: true, isOutdated: false, originalLine: 12,
    url: "https://github.com/acme/shop-api/pull/482#discussion_r3",
    diffHunk: "@@ -9,4 +9,6 @@\n+const CENTS = 100;",
    comments: [{
      id: "IC_demo4", databaseId: 90004, author: "jkwan", isBot: false, createdAt: ago(340),
      body: "Name it `CENTS_PER_UNIT`? `CENTS` reads like a count.",
    }, {
      id: "IC_demo5", databaseId: 90005, author: "rmoreno", isBot: false, createdAt: ago(320),
      body: "Renamed.",
    }],
  },
];

const PR_482_DETAIL: PrDetail = {
  ...PR_SUMMARIES[0],
  body: [
    "Prices were rounded per line item, so a cart of 3 × €4.995 charged €15.00 while the",
    "invoice said €14.99. Rounding moves to the cart boundary.",
    "",
    "- [x] Unit tests for the boundary case",
    "- [x] Backfill script for `orders_2024`",
    "- [ ] Soak on staging for 24h",
    "",
    "Fixes #477.",
  ].join("\n"),
  mergeable: "MERGEABLE", mergeState: "BLOCKED",
  checklist: [
    { checked: true, text: "Unit tests for the boundary case" },
    { checked: true, text: "Backfill script for `orders_2024`" },
    { checked: false, text: "Soak on staging for 24h" },
  ],
  reviewers: ["you", "jkwan"], assignees: ["rmoreno"],
  reviews: [
    { author: "rmoreno", isBot: false, state: "CHANGES_REQUESTED", submittedAt: ago(118),
      body: "One blocker on legacy carts — see the thread on `pricing.ts`. Everything else reads well." },
    { author: "jkwan", isBot: false, state: "COMMENTED", submittedAt: ago(96), body: "" },
    { author: "acme-ci", isBot: true, state: "COMMENTED", submittedAt: ago(110), body: "Coverage report attached." },
  ],
  comments: [
    { id: 70001, author: "t-okafor", isBot: false, createdAt: ago(180),
      body: "Worth a changelog entry — this changes what customers are charged." },
    { id: 70002, author: "acme-ci", isBot: true, createdAt: ago(110),
      body: "<!-- coverage-report -->\n## Coverage report\n\n| File | Stmts | Branch | Funcs | Lines |\n| --- | --- | --- | --- | --- |\n" +
        Array.from({ length: 180 }, (_, i) => `| src/module_${i}.ts | 98.${i % 10}% | 91.${i % 10}% | 100% | 98.${i % 10}% |`).join("\n"),
      digest: "coverage 91.4% (+0.8%) · 6 files changed · 0 uncovered lines added" },
  ],
  threads: PR_482_THREADS,
  commits: [
    { oid: "a1c4e70f2b19d3c8", short: "a1c4e70", message: "Round at the cart boundary", author: "rmoreno", isMerge: false },
    { oid: "b2d5f81a3c20e4d9", short: "b2d5f81", message: "Guard assertRounded for legacy carts", author: "rmoreno", isMerge: false },
    { oid: "c3e6a92b4d31f5ea", short: "c3e6a92", message: "Backfill script for orders_2024", author: "rmoreno", isMerge: false },
  ],
  files: [
    { path: "src/services/pricing.ts", additions: 34, deletions: 11, status: "modified", comments: 1 },
    { path: "src/routes/checkout.ts", additions: 8, deletions: 6, status: "modified", comments: 1 },
    { path: "src/lib/money.ts", additions: 22, deletions: 0, status: "added", comments: 0 },
    { path: "scripts/backfill_orders_2024.ts", additions: 14, deletions: 0, status: "added", comments: 0 },
    { path: "test/pricing.boundary.test.ts", additions: 6, deletions: 0, status: "added", comments: 0 },
    { path: "src/legacy/coupon_v1.ts", additions: 0, deletions: 14, status: "removed", comments: 0 },
  ],
  checksAll: [
    chk("lint", "success"), chk("typecheck", "success"), chk("unit", "success"),
    chk("e2e (checkout)", "failure"), chk("license-scan", "skipped", "compliance"),
  ],
  forcePushedSinceReview: false, viewerDidAuthor: false, viewerRequested: true,
};

/** The other six: enough detail to open, plus the one state each exists to
 *  show. `mergeState` is the interesting field — a disabled merge button that
 *  cannot say why is the thing this panel was written to replace. */
const PR_EXTRA: Record<number, Partial<PrDetail>> = {
  479: {
    body: "Memoises the price table for the life of a request. p95 on `/checkout` goes 73ms → 41ms on staging.",
    mergeable: "MERGEABLE", mergeState: "CLEAN",
    reviewers: ["rmoreno"],
    reviews: [{ author: "rmoreno", isBot: false, state: "APPROVED", submittedAt: ago(50), body: "Nice. Ship it." }],
    files: [
      { path: "src/services/pricing.ts", additions: 28, deletions: 9, status: "modified", comments: 0 },
      { path: "src/lib/requestCache.ts", additions: 11, deletions: 0, status: "added", comments: 0 },
      { path: "test/pricing.cache.test.ts", additions: 2, deletions: 3, status: "modified", comments: 0 },
    ],
    checksAll: [chk("lint", "success"), chk("typecheck", "success"), chk("unit", "success"), chk("e2e (checkout)", "success"), chk("bench", "success")],
  },
  476: {
    body: "Bumps `bun` from 1.1.34 to 1.1.38.\n\nOpened automatically by the dependency bot. Release notes are linked from the tag.",
    mergeable: "MERGEABLE", mergeState: "CLEAN",
    files: [
      { path: "package.json", additions: 1, deletions: 1, status: "modified", comments: 0 },
      { path: "bun.lockb", additions: 3, deletions: 3, status: "modified", comments: 0 },
    ],
    checksAll: [chk("lint", "success"), chk("typecheck", "success"), chk("unit", "success"), chk("e2e (checkout)", "success"), chk("bench", "success")],
  },
  471: {
    body: "Draft. Spans around PreToolUse/PostToolUse so a held call shows up on the trace.\n\n- [ ] Decide on span names\n- [ ] Sampling rate",
    mergeable: "UNKNOWN", mergeState: "DRAFT",
    checklist: [{ checked: false, text: "Decide on span names" }, { checked: false, text: "Sampling rate" }],
    files: [{ path: "src/otel/gate.ts", additions: 118, deletions: 0, status: "added", comments: 0 }],
    checksAll: [chk("lint", "success"), chk("typecheck", "success"), chk("unit", "pending"), chk("e2e (checkout)", "pending"), chk("bench", "pending")],
  },
  468: {
    body: "The checkout e2e fails about one run in nine under parallel load. Serialises the fixture teardown.",
    mergeable: "MERGEABLE", mergeState: "UNSTABLE",
    reviewers: ["you"],
    reviews: [{ author: "t-okafor", isBot: false, state: "CHANGES_REQUESTED", submittedAt: ago(280),
      body: "Serialising teardown hides it rather than fixing it — the fixture leaks a connection." }],
    files: [
      { path: "test/checkout.e2e.ts", additions: 41, deletions: 38, status: "modified", comments: 1 },
      { path: "test/support/fixture.ts", additions: 22, deletions: 6, status: "modified", comments: 0 },
    ],
    checksAll: [chk("lint", "success"), chk("typecheck", "success"), chk("integration (postgres)", "failure"), chk("license-scan", "skipped", "compliance")],
    // force-pushed after t-okafor reviewed: that review is stale and the panel says so
    forcePushedSinceReview: true, viewerRequested: true,
  },
  465: {
    body: "Retries a card charge once on a 5xx from the PSP before failing the order.",
    mergeable: "CONFLICTING", mergeState: "DIRTY",
    files: [
      { path: "src/payments/charge.ts", additions: 61, deletions: 12, status: "modified", comments: 0 },
      { path: "src/payments/retry.ts", additions: 30, deletions: 0, status: "added", comments: 0 },
    ],
    checksAll: [chk("lint", "success"), chk("typecheck", "success"), chk("unit", "success"), chk("e2e (checkout)", "success"), chk("license-scan", "skipped", "compliance")],
    // you opened this one: GitHub will not let you review your own work
    viewerDidAuthor: true,
  },
  461: {
    body: "The v1 coupon table has had no writes since the v2 migration. Drops the table and its dead code paths.",
    mergeable: "MERGEABLE", mergeState: "BEHIND",
    reviews: [{ author: "rmoreno", isBot: false, state: "APPROVED", submittedAt: ago(1_400), body: "" }],
    files: [
      { path: "src/legacy/coupon_v1.ts", additions: 0, deletions: 412, status: "removed", comments: 0 },
      { path: "migrations/031_drop_coupons_v1.sql", additions: 9, deletions: 0, status: "added", comments: 0 },
    ],
    checksAll: [chk("lint", "success"), chk("typecheck", "success"), chk("unit", "success"), chk("e2e (checkout)", "success"), chk("bench", "success")],
  },
};

function prDetailOf(n: number): PrDetail | null {
  if (n === 482) return PR_482_DETAIL;
  const s = PR_SUMMARIES.find((p) => p.number === n);
  if (!s) return null;
  const x = PR_EXTRA[n] ?? {};
  return {
    ...s,
    body: "", mergeable: "UNKNOWN", mergeState: "UNKNOWN", checklist: [],
    reviewers: [], assignees: s.assignees, reviews: [], comments: [], threads: [],
    commits: [{ oid: "d4f7b03c5e42a6fb", short: "d4f7b03", message: s.title, author: s.author, isMerge: false }],
    files: [], checksAll: [],
    forcePushedSinceReview: false, viewerDidAuthor: false, viewerRequested: false,
    ...x,
  };
}

/** A unified diff for the flagship, so the Files tab has something real to
 *  render rather than an empty state. */
const PR_482_DIFF = `diff --git a/src/services/pricing.ts b/src/services/pricing.ts
index 3f1a9c2..8b4e7d1 100644
--- a/src/services/pricing.ts
+++ b/src/services/pricing.ts
@@ -56,10 +56,13 @@ import { round2 } from "../lib/money.ts";
 export function cartTotal(cart: Cart) {
-  const subtotal = cart.items.reduce((s, i) => s + round2(i.price * i.qty), 0);
-  return applyCoupon(subtotal, cart.coupon);
+  const subtotal = cart.items.reduce((s, i) => s + i.price * i.qty, 0);
+  assertRounded(subtotal);
+  const discount = cart.coupon ? applyCoupon(subtotal, cart.coupon) : 0;
+  return round2(Math.max(0, subtotal - discount));
 }
diff --git a/src/lib/money.ts b/src/lib/money.ts
new file mode 100644
index 0000000..1d9c4a7
--- /dev/null
+++ b/src/lib/money.ts
@@ -0,0 +1,8 @@
+const CENTS_PER_UNIT = 100;
+
+/** Half-up to the minor unit. Banker's rounding under-charges at scale. */
+export const round2 = (n: number) =>
+  Math.round((n + Number.EPSILON) * CENTS_PER_UNIT) / CENTS_PER_UNIT;
+
+export const assertRounded = (n: number) => {
+  if (Math.abs(n * CENTS_PER_UNIT - Math.round(n * CENTS_PER_UNIT)) > 1e-6) throw new Error("unrounded money: " + n);
+};
diff --git a/src/routes/checkout.ts b/src/routes/checkout.ts
index 7c2b415..e91d3a8 100644
--- a/src/routes/checkout.ts
+++ b/src/routes/checkout.ts
@@ -113,9 +113,11 @@ router.post("/checkout", async (req, res) => {
   const cart = await carts.load(req.body.cartId);
-  const total = round2(cartTotal(cart));
-  if (total <= 0) return res.status(400).json({ error: "empty cart" });
+  const total = cartTotal(cart);           // already rounded at the boundary
+  if (total <= 0) return res.status(400).json({ error: "empty cart" });
+  req.log.info({ cartId: cart.id, total }, "checkout total");
   const charge = await psp.charge(cart.customerId, total);
   return res.json({ orderId: charge.orderId, total });
 });
diff --git a/scripts/backfill_orders_2024.ts b/scripts/backfill_orders_2024.ts
new file mode 100644
index 0000000..5a1f8c3
--- /dev/null
+++ b/scripts/backfill_orders_2024.ts
@@ -0,0 +1,14 @@
+/* One-shot: re-round the 2024 orders written before the boundary change.
+   Idempotent — re-running it is a no-op once every row is clean. */
+import { db } from "../src/db.ts";
+import { round2 } from "../src/lib/money.ts";
+
+const rows = await db.query("select id, total from orders_2024 where rounded = false");
+for (const r of rows) {
+  await db.exec("update orders_2024 set total = ?, rounded = true where id = ?", [round2(r.total), r.id]);
+}
+console.log("backfilled " + rows.length + " orders");
diff --git a/test/pricing.boundary.test.ts b/test/pricing.boundary.test.ts
new file mode 100644
index 0000000..2e7d90b
--- /dev/null
+++ b/test/pricing.boundary.test.ts
@@ -0,0 +1,6 @@
+test("three items at 4.995 charge what the invoice says", () => {
+  const cart = { items: [{ price: 4.995, qty: 3 }], coupon: null };
+  expect(cartTotal(cart)).toBe(14.99);
+});
diff --git a/src/legacy/coupon_v1.ts b/src/legacy/coupon_v1.ts
deleted file mode 100644
index c81a5e0..0000000
--- a/src/legacy/coupon_v1.ts
+++ /dev/null
@@ -1,14 +0,0 @@
-/* Superseded by applyCoupon in services/pricing.ts. */
-export function applyCouponV1(subtotal: number, code: string | null) {
-  if (!code) return subtotal;
-  const pct = LEGACY_CODES[code];
-  return pct ? subtotal - subtotal * pct : subtotal;
-}
`;

export function prCapability() {
  return { available: true, authed: true, login: "you" };
}
export function prList(root: string): PrListResponse {
  // Only the fictional shop-api has a forge remote in this fixture; the other
  // checkout answers "no pull requests here", which is a real state too.
  const mine = /shop-api/.test(root);
  return {
    ok: true, repo: mine ? PR_REPO : null, prs: mine ? PR_SUMMARIES : [],
    fetchedAt: Date.now() - 90_000, stale: false, loading: false, checksPending: false,
  };
}
export function prDetail(n: number): { ok: boolean; detail?: PrDetail; error?: string } {
  const d = prDetailOf(n);
  return d ? { ok: true, detail: d } : { ok: false, error: "no such pull request in the demo" };
}
export function prDiff(n: number): { ok: boolean; text?: string; error?: string } {
  return n === 482 ? { ok: true, text: PR_482_DIFF } : { ok: true, text: "" };
}
