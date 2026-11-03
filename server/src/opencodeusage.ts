// OpenCode Go's plan quota, counted from this machine's own turns.
//
// The numbers that matter are the last 5 h, week and month of worker steps
// agentglass ran here, priced by the step_finish events in each turn's `out`
// file and the plan's published dollar caps. That under-reads the console
// (measured 31 Oct: $7.07 here against $15.9 there for the same week), so the
// row says "this PC" and the console survives only as an optional calibration
// line, read through the app's browser when the person presses the button.
//
// The page is somebody else's HTML and can change without notice. Every failure
// — signed out, a layout that no longer shows the three windows, a browser that
// will not answer — comes back as an unavailable row with a sentence, and never
// as a number. A gauge showing 0% because parsing failed is the one bug this
// file exists to prevent.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderUsage, QuotaWindow } from "../../shared/types.ts";
import { cliLink } from "./browseruse.ts";
import { readUsageLimits } from "./opencodeapi.ts";
import { singleFlight } from "./singleflight.ts";
import { hasUsageKey, usageKey } from "./usagekey.ts";
import { usageRead } from "./usageevents.ts";

/** The workspace console: the signed-in page that carries the Go tab. */
export const PAGE_URL = "https://opencode.ai/workspace";
/** Its own container, so a read never lands in the person's tab. */
const PROFILE = "usage-opencode";
const LABEL = "OpenCode Go";
const TTL_MS = 3 * 60_000;
const CLI_TIMEOUT_MS = 20_000;

export type OpenCodeReading =
  | { status: "ok"; windows: QuotaWindow[] }
  | { status: "unavailable"; reason: string };

const unavailable = (reason: string): OpenCodeReading => ({ status: "unavailable", reason });

/** Named entities the console actually uses, decoded after the tags are gone. */
export function visibleText(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function durationMs(text: string): number | null {
  const unit = (u: string): number => {
    switch (u[0]!.toLowerCase()) {
      case "d": return 86_400_000;
      case "h": return 3_600_000;
      case "m": return 60_000;
      default: return 1_000;
    }
  };
  const re = /(\d+)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/gi;
  let total = 0;
  let seen = false;
  for (const m of text.matchAll(re)) {
    total += Number(m[1]) * unit(m[2]!);
    seen = true;
  }
  return seen ? total : null;
}

/** The three windows the Go tab draws, in the order a gauge wants them. */
const WINDOWS = [
  { minutes: 300, label: "5h", header: /5[\s-]*hour(?:\s+window)?/i },
  { minutes: 10080, label: "weekly", header: /weekly(?:\s+(?:window|limit))?/i },
  { minutes: 43200, label: "monthly", header: /monthly(?:\s+(?:window|limit))?/i },
] as const;

const SIGNED_OUT =
  "OpenCode Go is not signed in in its browser profile. Sign in to opencode.ai once in the "
  + "'usage-opencode' tab and this reading appears.";

function signedOut(text: string, url: string): boolean {
  if (/\/login\b|\/sign[-_]?in\b|\/auth\b/i.test(url)) return true;
  return /log\s*in\s+to\s+opencode|sign\s*in\s+to\s+opencode|continue\s+with\s+(google|github|email)/i.test(text);
}

/**
 * Parse the console page's text (or its HTML) into the three windows.
 *
 * Each window is read from its own header to the next one, so a percentage in
 * another section cannot be borrowed. Requiring all three is deliberate: a plan
 * that quietly lost a window is a page that changed shape, and two numbers and
 * a guess is worse than saying so.
 */
export function parseOpenCodeConsole(raw: string, now = Date.now(), url = ""): OpenCodeReading {
  const text = visibleText(raw);
  if (!text) return unavailable("OpenCode's console page came back empty — its layout may have changed.");
  if (signedOut(text, url)) return unavailable(SIGNED_OUT);

  const hits = WINDOWS
    .map((w) => ({ w, at: text.search(w.header) }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at);

  const windows: QuotaWindow[] = [];
  for (let i = 0; i < hits.length; i++) {
    const { w, at } = hits[i]!;
    const end = Math.min(hits[i + 1]?.at ?? text.length, at + 320);
    const segment = text.slice(at, end);
    const pct = segment.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
    if (!pct) continue;
    const used = Math.round(Number(pct[1]!.replace(",", ".")));
    if (!Number.isFinite(used)) continue;
    const reset = segment.match(/resets?\s+in\s+((?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\s*)+)/i);
    const ms = reset ? durationMs(reset[1]!) : null;
    windows.push({
      label: w.label,
      minutes: w.minutes,
      usedPercent: Math.max(0, Math.min(100, used)),
      resetsAt: ms === null ? null : new Date(now + ms).toISOString(),
    });
  }

  if (windows.length === WINDOWS.length) {
    return { status: "ok", windows: windows.sort((a, b) => a.minutes - b.minutes) };
  }
  const found = windows.length ? `only ${windows.map((w) => w.label).join(", ")}` : "none";
  return unavailable(
    `OpenCode's console page showed ${found} of its three usage windows (5-hour, weekly, monthly) `
    + "— the page may have changed.",
  );
}

export function openCodeRow(reading: OpenCodeReading, at = Date.now()): ProviderUsage {
  if (reading.status === "ok") {
    return { provider: "opencode", label: LABEL, available: true, windows: reading.windows, observedAt: at };
  }
  return { provider: "opencode", label: LABEL, available: false, windows: [], note: reading.reason };
}

/**
 * The CLI to drive the browser with.
 *
 * The installed symlink first, because a desktop app launched from the GUI does
 * not inherit ~/.local/bin on PATH. The env override is what a test uses to
 * stand in a script instead of a browser.
 */
export function openCodeCli(): string | null {
  const override = process.env.AGENTGLASS_OPENCODE_BROWSER;
  if (override) return override;
  const link = cliLink();
  if (existsSync(link)) return link;
  return Bun.which("agentglass-browser");
}

type CliRun = { code: number; out: string; err: string } | { error: string };

async function runCli(cli: string, args: string[]): Promise<CliRun> {
  try {
    const proc = Bun.spawn([cli, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: CLI_TIMEOUT_MS,
      // The CLI's own token file is the machine token; an inherited scoped one
      // could lack the browser scope and make a working setup look broken.
      env: { ...process.env, AGENTGLASS_TOKEN: "" },
    });
    const out = new Response(proc.stdout).text();
    const err = new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, out: await out, err: await err };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 240);

/** `read` prints three header lines (title, url, blank) and then the text,
 *  because its caller is a model and JSON around a page is punctuation it pays
 *  for. A JSON answer is still accepted: that is what the tests stand in. */
function readAnswer(out: string): { text: string; url: string } | { error: string } {
  if (out.trimStart().startsWith("{")) {
    let doc: unknown;
    try { doc = JSON.parse(out); } catch { return { error: "the browser answered with something that was not JSON" }; }
    const d = doc as { ok?: unknown; error?: unknown; value?: { text?: unknown; url?: unknown } };
    if (!d || d.ok !== true) {
      return { error: typeof d?.error === "string" && d.error ? d.error : "the browser refused the read" };
    }
    const text = d.value?.text;
    if (typeof text !== "string") return { error: "the browser answered without the page's text" };
    return { text, url: typeof d.value?.url === "string" ? d.value.url : "" };
  }
  const lines = out.split("\n");
  if (lines.length >= 3 && /^https?:\/\//.test(lines[1]?.trim() ?? "")) {
    return { text: lines.slice(3).join("\n"), url: lines[1]!.trim() };
  }
  if (!out.trim()) return { error: "the page came back empty" };
  return { text: out, url: "" };
}

/** One read: open the console (which reloads it, so the numbers are current),
 *  then the page text. A second look covers a console that renders after load. */
async function fetchRow(cli: string): Promise<ProviderUsage> {
  const opened = await runCli(cli, ["--as", PROFILE, "open", PAGE_URL]);
  if ("error" in opened) return openCodeRow(unavailable(`Could not run agentglass's browser (${opened.error}).`));
  // A redirect to the login page answers the nav as "did not navigate" and the
  // page it left behind is the one that says why. So the failure is kept for
  // the case where the read cannot answer either, not returned here.
  const openError = opened.code === 0
    ? null
    : `OpenCode Go needs agentglass's browser: ${firstLine(opened.err) || `agentglass-browser exited ${opened.code}`}.`;

  let last: ProviderUsage | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await runCli(cli, ["--as", PROFILE, "read"]);
    if ("error" in read) return openCodeRow(unavailable(`Could not run agentglass's browser (${read.error}).`));
    if (read.code !== 0) {
      last = openCodeRow(unavailable(
        openError ?? `Could not read OpenCode's console page: ${firstLine(read.err) || `agentglass-browser exited ${read.code}`}.`,
      ));
    } else {
      const answer = readAnswer(read.out);
      last = "error" in answer
        ? openCodeRow(unavailable(`Could not read OpenCode's console page: ${answer.error}.`))
        : openCodeRow(parseOpenCodeConsole(answer.text, Date.now(), answer.url));
    }
    // A signed-out page will not become signed in by looking twice.
    if (last.available || /not signed in/.test(last.note ?? "")) return last;
    if (attempt === 0) await Bun.sleep(700);
  }
  return last!;
}

let cache: { at: number; row: ProviderUsage } | null = null;

// ── the last console reading, kept across restarts ─────────────────────
//
// A restart used to lose the console numbers, so the first snapshot was the
// local estimate (21 % here) until a read landed (54 % on the plan). This file
// is percentages and reset times only; the key stays in usagekey.ts.

type Calibration = { at: number; windows: QuotaWindow[] };

let saved: Calibration | null | undefined;

function calibrationFile(): string {
  return join(stateDir(), "opencode-console.json");
}

const validWindow = (w: unknown): w is QuotaWindow => {
  const o = (w ?? {}) as QuotaWindow;
  return typeof o.label === "string" && Number.isFinite(o.minutes)
    && Number.isFinite(o.usedPercent) && (o.resetsAt === null || typeof o.resetsAt === "string");
};

function loadCalibration(): Calibration | null {
  if (saved !== undefined) return saved;
  saved = null;
  try {
    const raw = JSON.parse(readFileSync(calibrationFile(), "utf8")) as { at?: unknown; windows?: unknown };
    const at = Number(raw.at);
    const windows = Array.isArray(raw.windows) ? raw.windows.filter(validWindow) : [];
    if (Number.isFinite(at) && windows.length) saved = { at, windows };
  } catch { /* no file yet: the local estimate answers */ }
  return saved;
}

function saveCalibration(c: Calibration): void {
  const p = calibrationFile();
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: c.at, windows: c.windows }), { mode: 0o600 });
    renameSync(tmp, p);
  } catch { /* the in-memory reading still answers this run */ }
}

/** The reading the panel may draw: a live successful read first, else the file. */
function calibrationRow(): Calibration | null {
  if (cache?.row.available && cache.row.windows.length) {
    return { at: cache.at, windows: cache.row.windows };
  }
  return loadCalibration();
}

// ── the local windows: the numbers the panel shows ─────────────────────
//
// OpenCode's docs price the Go plan at $12 / 5 h, $30 / week and $60 / month,
// rolling. Its own usage page is the authority, but reading it needs a browser
// and the person's login; the turns agentglass runs here already carry every
// step's cost. So the windows are summed from those steps and labelled
// "this PC": measured on 31 Oct, the console said weekly $15.9 while the local
// CLI said $7.07 for the same week, so this under-reads. The console stays as
// an optional calibration line, never as the number the bar draws.

/** Dollars per window, from OpenCode's published Go caps. */
export const CAPS_USD: Record<number, number> = { 300: 12, 10080: 30, 43200: 60 };
const KEEP_MS = 31 * 86_400_000;
const NO_TURNS =
  "No OpenCode worker turn on this PC yet, so there is no local spend to count. "
  + "Start a worker and this fills in from its steps.";

export type SpendStep = { at: number; cost: number; tokens: number; key: string };

function stateDir(): string {
  return process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
}

function storeFile(): string {
  return join(stateDir(), "opencode-spend.json");
}

type SpendStore = { steps: SpendStep[]; backfilled?: boolean };

let store: SpendStore | null = null;

function loadStore(): SpendStore {
  if (store) return store;
  store = { steps: [] };
  try {
    const raw = JSON.parse(readFileSync(storeFile(), "utf8")) as { steps?: unknown; backfilled?: unknown };
    if (Array.isArray(raw.steps)) {
      store.steps = raw.steps.filter((s): s is SpendStep =>
        !!s && typeof s === "object"
        && Number.isFinite((s as SpendStep).at) && Number.isFinite((s as SpendStep).cost)
        && (s as SpendStep).cost > 0 && typeof (s as SpendStep).key === "string");
    }
    if (raw.backfilled === true) store.backfilled = true;
  } catch { /* no file yet, or one a half-written turn left: start from empty */ }
  return store;
}

function saveStore(s: SpendStore): void {
  const p = storeFile();
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, p);
  } catch { /* the in-memory steps still answer this run */ }
}

const tokensOf = (t: unknown): number => {
  const o = (t ?? {}) as { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown } };
  const n = [o.input, o.output, o.reasoning, o.cache?.read].map((x) => Number(x) || 0);
  return n.reduce((a, b) => a + b, 0);
};

/**
 * Take the steps out of one finished turn's `out` file.
 *
 * Called wherever the turn's status is read (headless.ts), which the ceiling
 * watch already does on the folder's event; the key makes a second read of the
 * same file add nothing, so a restart or a poll cannot count a turn twice.
 * Zero-cost steps are dropped: they move no dollar window.
 */
export function recordOpenCodeTurn(outPath: string, now = Date.now()): number {
  let text: string;
  try { text = readFileSync(outPath, "utf8"); } catch { return 0; }
  const s = loadStore();
  const seen = new Set(s.steps.map((x) => x.key));
  let added = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let f: Record<string, unknown>;
    try { f = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (f.type !== "step_finish" && f.type !== "step-finish") continue;
    const part = (f.part ?? {}) as Record<string, unknown>;
    const at = Number(f.timestamp ?? part.timestamp);
    const cost = Number(part.cost ?? f.cost);
    if (!Number.isFinite(at) || !(cost > 0)) continue;
    const key = `${String(f.sessionID ?? "")}:${at}:${cost}`;
    if (seen.has(key)) continue;
    seen.add(key);
    s.steps.push({ at, cost, tokens: tokensOf(part.tokens), key });
    added++;
  }
  if (!added) return 0;
  s.steps = s.steps.filter((x) => now - x.at < KEEP_MS).sort((a, b) => a.at - b.at);
  saveStore(s);
  cache = null;
  return added;
}

/** A rolling window: what the last `minutes` cost, against the cap. */
export function rollingWindow(steps: readonly SpendStep[], minutes: number, now = Date.now()): QuotaWindow {
  const since = now - minutes * 60_000;
  const inside = steps.filter((s) => s.at > since);
  const spent = inside.reduce((a, b) => a + b.cost, 0);
  const cap = CAPS_USD[minutes] ?? 0;
  const oldest = inside.length ? inside[0]!.at : null;
  return {
    label: minutes === 300 ? "5h" : minutes === 10080 ? "weekly" : "monthly",
    minutes,
    usedPercent: cap > 0 ? Math.round((spent / cap) * 1000) / 10 : 0,
    // The spend leaves the window when its oldest step does, not at a fixed hour.
    resetsAt: oldest === null ? null : new Date(oldest + minutes * 60_000).toISOString(),
  };
}

/** Tokens per UTC day, for the panel's bars, from the same recorded steps. */
export function dailyTokens(steps: readonly SpendStep[], now = Date.now()): { day: string; tokens: number }[] {
  const out = new Map<string, number>();
  for (let i = 6; i >= 0; i--) out.set(new Date(now - i * 86_400_000).toISOString().slice(0, 10), 0);
  for (const s of steps) {
    const day = new Date(s.at).toISOString().slice(0, 10);
    if (out.has(day)) out.set(day, (out.get(day) ?? 0) + s.tokens);
  }
  return [...out].map(([day, tokens]) => ({ day, tokens }));
}

/** The turn folders this machine still has, backfilled once. A store written
 *  before the recorder existed has no `backfilled` mark either, so it fills in
 *  on the first read and never scans again. The dedupe key makes a second run
 *  of the same folder add nothing. */
function backfillOnce(now: number): void {
  const s = loadStore();
  if (s.backfilled) return;
  s.backfilled = true;
  const runs = join(stateDir(), "worker-runs");
  let names: string[] = [];
  try {
    names = readdirSync(runs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* no worker has run here yet */ }
  for (const name of names) recordOpenCodeTurn(join(runs, name, "out"), now);
  saveStore(loadStore());
}

/** What to show when this PC has no recorded spend: the console's numbers if a
 *  key or an earlier read has them, else the engine's own stats totals. Never
 *  the empty-looking panel that merely means "no worker ran in agentglass". */
function storedReading(now: number, cal: Calibration | null): ProviderUsage | null {
  if (cal) {
    return {
      provider: "opencode", label: LABEL, available: true, windows: cal.windows, plan: "Go",
      source: hasUsageKey() ? "console key" : "console",
      observedAt: cal.at,
    };
  }
  const detail = openCodeDetail(30);
  if (!detail || !(detail.costUsd > 0 || detail.models.length)) return null;
  const last = detail.daily.at(-1)?.day;
  return {
    provider: "opencode", label: LABEL, available: true, windows: [], plan: "Go",
    source: "opencode stats",
    spend: { usd: detail.costUsd, window: "30 days" },
    observedAt: last ? Date.parse(last) : now,
    daily: detail.daily.map((d) => ({ day: d.day, tokens: d.tokens })),
  };
}

/** The local row: rolling windows from what this machine's turns spent. */
export function opencodeUsage(now = Date.now()): ProviderUsage {
  backfillOnce(now);
  const steps = loadStore().steps;
  const keyed = hasUsageKey() ? { usageKey: true } : {};
  const failed = cache && !cache.row.available && hasUsageKey() ? { usageNote: cache.row.note } : {};
  const cal = calibrationRow();
  if (!steps.length) {
    const fallback = storedReading(now, cal);
    if (fallback) return { ...fallback, ...keyed, ...failed, ...(cal ? { calibration: cal } : {}) };
    return { ...openCodeRow(unavailable(NO_TURNS)), ...keyed, ...failed };
  }
  const windows = [300, 10080, 43200].map((m) => rollingWindow(steps, m, now));
  return {
    provider: "opencode", label: LABEL, available: true, plan: "Go",
    source: "this PC", windows, observedAt: steps[steps.length - 1]!.at,
    daily: dailyTokens(steps, now),
    ...keyed,
    ...(cal ? { calibration: cal } : {}),
    ...failed,
  };
}

/**
 * Read the console, at most once per three minutes unless asked to now.
 *
 * A key, when the person stored one, is the source: it covers the whole plan
 * and needs no browser. Without one this falls back to the signed-in console
 * page, which is where the calibration line came from before the key existed.
 * Either way the answer is folded in as a second line; the local number is what
 * the bar draws.
 */
export async function refreshOpenCodeUsage(force = false): Promise<ProviderUsage> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.row;
  return singleFlight("opencode-usage", async () => {
    const key = usageKey();
    let row: ProviderUsage;
    if (key) {
      const reading = await readUsageLimits(key);
      row = reading.status === "ok"
        ? openCodeRow(reading)
        : openCodeRow(unavailable(reading.reason));
    } else {
      const cli = openCodeCli();
      row = cli
        ? await fetchRow(cli)
        : openCodeRow(unavailable("agentglass-browser is not installed on this machine, so the console reading cannot be read."));
    }
    cache = { at: Date.now(), row };
    if (row.available && row.windows.length) saveCalibration({ at: cache.at, windows: row.windows });
    usageRead();
    return row;
  });
}

/** Test seam: forget the cached reading, as a restart does; the file is re-read. */
export function __resetOpenCodeUsageCache(): void { cache = null; saved = undefined; }
/** Test seam: forget the recorded steps too. */
export function __resetOpenCodeSpend(): void { store = null; cache = null; saved = undefined; stats = null; }

// ── per-model detail, from the engine's own stats ──────────────────────
//
// `opencode stats --days N --models --cost --json --standalone` walks the
// sessions this machine already has: no key, no network, and the shape below
// was read on 31 Oct. Asked when the panel opens or its detail is unfolded,
// cached for a few minutes, never on the poll.

export type ModelSpend = { model: string; steps: number; costUsd: number; tokens: number };
export type OpenCodeDetail = { models: ModelSpend[]; daily: { day: string; tokens: number; costUsd: number }[]; costUsd: number; steps: number };

let stats: { at: number; detail: OpenCodeDetail } | null = null;
const STATS_TTL_MS = 5 * 60_000;

function parseStats(raw: string): OpenCodeDetail | null {
  let d: Record<string, unknown>;
  try { d = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const models = Array.isArray(d.models) ? d.models.flatMap((m) => {
    const r = m as { model?: { id?: unknown; providerID?: unknown }; steps?: unknown; cost?: unknown; tokens?: unknown };
    const id = typeof r.model?.id === "string" ? r.model.id : "";
    if (!id) return [];
    return [{ model: id, steps: Number(r.steps) || 0, costUsd: Number(r.cost) || 0, tokens: tokensOf(r.tokens) }];
  }) : [];
  const daily = Array.isArray(d.activity) ? d.activity.flatMap((a) => {
    const r = a as { date?: unknown; tokens?: unknown; steps?: unknown; cost?: unknown };
    if (typeof r.date !== "string") return [];
    return [{ day: r.date, tokens: Number(r.tokens) || 0, costUsd: Number(r.cost) || 0 }];
  }) : [];
  const out = { models, daily, costUsd: Number(d.cost) || 0, steps: Number(d.steps) || 0 };
  // A shape with neither list is a CLI that changed; say so by answering nothing
  // rather than an empty table a person would read as "spent nothing".
  return models.length || daily.length ? out : null;
}

export function openCodeDetail(days = 30, force = false): OpenCodeDetail | null {
  if (!force && stats && Date.now() - stats.at < STATS_TTL_MS) return stats.detail;
  const fixture = process.env.AGENTGLASS_OPENCODE_STATS;
  let raw: string | null = null;
  try {
    if (fixture) raw = readFileSync(fixture, "utf8");
    else {
      const bin = Bun.which("opencode");
      if (bin) {
        const r = Bun.spawnSync([bin, "stats", "--days", String(days), "--models", "--cost", "--json", "--standalone"], { timeout: 8_000 });
        if (r.exitCode === 0) raw = r.stdout.toString();
      }
    }
  } catch { raw = null; }
  const detail = raw ? parseStats(raw) : null;
  if (!detail) return null;
  stats = { at: Date.now(), detail };
  return detail;
}
