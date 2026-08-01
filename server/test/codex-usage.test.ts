/*
 * Reading Codex's plan quota off disk.
 *
 * The CLI already writes what a gauge needs into its session rollout files, so
 * this needs no credentials and no network — but it is somebody else's file
 * format, written by a binary that updates itself, so every assumption it makes
 * is pinned here. The one that matters most is freshness: `rate_limits` is only
 * written when a turn runs, so "the newest reading wins" is not a nicety, it is
 * the difference between today's number and one from last week.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowLabel } from "../../shared/quota.ts";
import { codexUsage, __resetCodexUsageCache } from "../src/codexusage.ts";

let dir: string | null = null;

function home(): string {
  dir = mkdtempSync(join(tmpdir(), "agx-codex-usage-"));
  process.env.CODEX_HOME = dir;
  __resetCodexUsageCache();
  return dir;
}

/** One rollout file, with whatever lines the test wants, aged so mtime
 *  ordering is deterministic rather than dependent on how fast the test ran. */
function rollout(root: string, day: string, name: string, lines: string[], ageSec = 0): string {
  const [y, m, d] = day.split("-");
  const dirPath = join(root, "sessions", y!, m!, d!);
  mkdirSync(dirPath, { recursive: true });
  const p = join(dirPath, name);
  writeFileSync(p, lines.join("\n") + "\n");
  const when = new Date(Date.now() - ageSec * 1000);
  utimesSync(p, when, when);
  return p;
}

const tokenCount = (usedPercent: number, windowMinutes: number, opts: {
  secondary?: { used_percent: number; window_minutes: number } | null;
  plan?: string;
  resetsAt?: number;
} = {}) => JSON.stringify({
  timestamp: "2026-07-31T23:41:35.574Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { model_context_window: 258400 },
    rate_limits: {
      limit_id: "codex",
      primary: {
        used_percent: usedPercent,
        window_minutes: windowMinutes,
        resets_at: opts.resetsAt ?? 1786114806,
      },
      secondary: opts.secondary
        ? { ...opts.secondary, resets_at: 1786114806 }
        : null,
      plan_type: opts.plan ?? "plus",
    },
  },
});

/** A line the reader must skip: a real rollout is mostly these. */
const otherLine = JSON.stringify({ type: "response_item", payload: { type: "message" } });

afterEach(() => {
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } }
  dir = null;
  delete process.env.CODEX_HOME;
  __resetCodexUsageCache();
});

describe("windowLabel", () => {
  test("names the windows Codex actually uses", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10080)).toBe("weekly");
  });

  test("computes anything else rather than guessing", () => {
    expect(windowLabel(180)).toBe("3h");
    expect(windowLabel(43200)).toBe("30d");
    expect(windowLabel(90)).toBe("90m");
  });
});

describe("reading a rollout", () => {
  test("parses percent, window, reset and plan", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [otherLine, tokenCount(5, 10080)]);
    const u = codexUsage();
    expect(u.available).toBe(true);
    expect(u.provider).toBe("codex");
    expect(u.plan).toBe("plus");
    expect(u.windows).toHaveLength(1);
    expect(u.windows[0]!.label).toBe("weekly");
    expect(u.windows[0]!.usedPercent).toBe(5);
    // Unix SECONDS in the file; ISO 8601 out.
    expect(u.windows[0]!.resetsAt).toBe(new Date(1786114806 * 1000).toISOString());
  });

  test("a null secondary yields one window, not a broken second one", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [tokenCount(5, 10080, { secondary: null })]);
    expect(codexUsage().windows).toHaveLength(1);
  });

  test("a present secondary yields both, labelled by length", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [
      tokenCount(12, 300, { secondary: { used_percent: 40, window_minutes: 10080 } }),
    ]);
    const w = codexUsage().windows;
    expect(w.map((x) => x.label)).toEqual(["5h", "weekly"]);
    expect(w.map((x) => x.usedPercent)).toEqual([12, 40]);
  });

  test("the newest reading wins", () => {
    const root = home();
    rollout(root, "2026-07-30", "rollout-old.jsonl", [tokenCount(90, 10080)], 7200);
    rollout(root, "2026-07-31", "rollout-new.jsonl", [tokenCount(5, 10080)], 60);
    expect(codexUsage().windows[0]!.usedPercent).toBe(5);
  });

  test("the last reading in a file wins over earlier ones", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [
      tokenCount(2, 10080), otherLine, tokenCount(7, 10080),
    ]);
    expect(codexUsage().windows[0]!.usedPercent).toBe(7);
  });

  test("falls back to an older file when the newest has no reading yet", () => {
    const root = home();
    rollout(root, "2026-07-30", "rollout-old.jsonl", [tokenCount(11, 10080)], 7200);
    // A session that has only just started: no token_count event written yet.
    rollout(root, "2026-07-31", "rollout-fresh.jsonl", [otherLine], 30);
    expect(codexUsage().windows[0]!.usedPercent).toBe(11);
  });

  test("reports when it was observed, from the file's mtime", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [tokenCount(5, 10080)], 3600);
    const u = codexUsage();
    const ageMs = Date.now() - (u.observedAt ?? 0);
    expect(ageMs).toBeGreaterThan(3_000_000);
    expect(ageMs).toBeLessThan(4_200_000);
  });
});

describe("when there is nothing to read", () => {
  test("no sessions directory: unavailable with a reason, never a throw", () => {
    home();
    const u = codexUsage();
    expect(u.available).toBe(false);
    expect(u.note).toBeTruthy();
    expect(u.windows).toEqual([]);
  });

  test("sessions exist but none carries a reading", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [otherLine, otherLine]);
    const u = codexUsage();
    expect(u.available).toBe(false);
    expect(u.note).toBeTruthy();
  });

  test("malformed JSON is skipped rather than fatal", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", ["{not json", tokenCount(5, 10080)]);
    expect(codexUsage().windows[0]!.usedPercent).toBe(5);
  });

  test("gives up after a bounded number of files", () => {
    const root = home();
    // Eight readless files, then a ninth with a reading that must NOT be found:
    // the bound is the point, and an unbounded scan would return 42 here.
    for (let i = 0; i < 8; i++) rollout(root, "2026-07-31", `rollout-${i}.jsonl`, [otherLine], i);
    rollout(root, "2026-07-20", "rollout-old.jsonl", [tokenCount(42, 10080)], 900);
    expect(codexUsage().available).toBe(false);
  });

  test("never leaks a filesystem path", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [otherLine]);
    expect(JSON.stringify(codexUsage())).not.toContain(root);
  });
});
