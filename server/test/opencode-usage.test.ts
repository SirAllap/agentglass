/*
 * OpenCode Go's quota, read from a page that is not ours.
 *
 * There is no usage endpoint, so the three numbers exist only in the console's
 * HTML. That makes two things worth pinning: the parser still finds the three
 * windows in a page it has never seen, and every way that page can stop being
 * readable — signed out, a layout that lost a window, a browser that will not
 * answer — comes back as an unavailable row with a sentence, not as a number.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseOpenCodeConsole, openCodeRow, opencodeUsage, refreshOpenCodeUsage, __resetOpenCodeUsageCache,
  recordOpenCodeTurn, rollingWindow, __resetOpenCodeSpend, openCodeDetail, type SpendStep,
} from "../src/opencodeusage.ts";

const FIXTURE = await Bun.file(new URL("./fixtures/opencode-console.html", import.meta.url)).text();
const NOW = Date.parse("2026-10-31T12:00:00Z");

/* The spend file is the app's state, and a test that read the real one would
   count this machine's turns. */
const wasState = process.env.AGENTGLASS_STATE_DIR;
const stateDir = mkdtempSync(join(tmpdir(), "agx-opencode-state-"));
process.env.AGENTGLASS_STATE_DIR = stateDir;
afterAll(() => {
  if (wasState === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = wasState;
  rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetOpenCodeSpend();
  rmSync(join(stateDir, "opencode-spend.json"), { force: true });
  rmSync(join(stateDir, "opencode-console.json"), { force: true });
  rmSync(join(stateDir, "worker-runs"), { recursive: true, force: true });
});

let dir: string | null = null;
let script: string | null = null;
const wasCli = process.env.AGENTGLASS_OPENCODE_BROWSER;
const wasCount = process.env.AGENTGLASS_TEST_OPENCODE_COUNT;

afterEach(() => {
  __resetOpenCodeUsageCache();
  __resetOpenCodeSpend();
  if (wasCli === undefined) delete process.env.AGENTGLASS_OPENCODE_BROWSER;
  else process.env.AGENTGLASS_OPENCODE_BROWSER = wasCli;
  if (wasCount === undefined) delete process.env.AGENTGLASS_TEST_OPENCODE_COUNT;
  else process.env.AGENTGLASS_TEST_OPENCODE_COUNT = wasCount;
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; script = null; }
});

/** A stand-in for agentglass-browser: it answers every verb with the same read,
 *  which is enough because `open` is judged on its exit code alone. */
function fakeBrowser(body: string): string {
  dir = mkdtempSync(join(tmpdir(), "agx-opencode-usage-"));
  script = join(dir, "browser.sh");
  const count = join(dir, "spawns");
  process.env.AGENTGLASS_TEST_OPENCODE_COUNT = count;
  writeFileSync(script, `#!/usr/bin/env bash\nprintf 'x\\n' >> "$AGENTGLASS_TEST_OPENCODE_COUNT"\nprintf '%s' '${body}'\n`);
  chmodSync(script, 0o755);
  return script;
}

const answer = (text: string, url = "https://opencode.ai/workspace"): string =>
  JSON.stringify({ ok: true, value: { url, text } });

const CONSOLE_TEXT =
  "5-hour window 4% used Resets in 3h 41m Weekly 1% used Resets in 1d 10h "
  + "Monthly 1% used Resets in 29d 22h";

describe("parsing the console", () => {
  test("finds all three windows, their numbers and when each comes back", () => {
    const r = parseOpenCodeConsole(FIXTURE, NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.windows.map((w) => [w.label, w.minutes, w.usedPercent])).toEqual([
      ["5h", 300, 4], ["weekly", 10080, 1], ["monthly", 43200, 1],
    ]);
    // 3h 41m and 1d 10h and 29d 22h, measured from the same `now`.
    expect(r.windows[0]!.resetsAt).toBe(new Date(NOW + (3 * 3600 + 41 * 60) * 1000).toISOString());
    expect(r.windows[1]!.resetsAt).toBe(new Date(NOW + 34 * 3600 * 1000).toISOString());
    expect(r.windows[2]!.resetsAt).toBe(new Date(NOW + (29 * 24 + 22) * 3600 * 1000).toISOString());
  });

  test("the browser's plain text parses the same as the HTML", () => {
    const r = parseOpenCodeConsole(CONSOLE_TEXT, NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.windows.map((w) => w.usedPercent)).toEqual([4, 1, 1]);
  });

  test("a signed-out page is unavailable, and says how to fix it", () => {
    const r = parseOpenCodeConsole(
      "Log in to OpenCode Console Continue with Google Continue with GitHub Continue with email",
      NOW, "https://opencode.ai/console/login",
    );
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.reason).toMatch(/not signed in/);
    expect(r.reason).toContain("usage-opencode");
  });

  test("a redirect to the auth page counts as signed out even with a blank page", () => {
    const r = parseOpenCodeConsole("OpenCode", NOW, "https://opencode.ai/auth/callback");
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.reason).toMatch(/not signed in/);
  });

  test("a page that lost a window is a shape change, not two numbers and a guess", () => {
    const r = parseOpenCodeConsole("5-hour window 4% used Resets in 3h 41m", NOW);
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.reason).toMatch(/only 5h/);
    expect(r.reason).toMatch(/may have changed/);
  });

  test("garbage in never throws and never invents a number", () => {
    for (const raw of ["", "<html><body></body></html>", "nothing here"]) {
      const r = parseOpenCodeConsole(raw, NOW);
      expect(r.status).toBe("unavailable");
    }
    const row = openCodeRow(parseOpenCodeConsole("nothing here", NOW), NOW);
    expect(row.available).toBe(false);
    expect(row.windows).toEqual([]);
    expect((row.note ?? "").length).toBeGreaterThan(10);
  });
});

describe("reading through the browser", () => {
  test("a signed-in console becomes a row with three windows", async () => {
    process.env.AGENTGLASS_OPENCODE_BROWSER = fakeBrowser(answer(CONSOLE_TEXT));
    const row = await refreshOpenCodeUsage(true);
    expect(row.provider).toBe("opencode");
    expect(row.label).toBe("OpenCode Go");
    expect(row.available).toBe(true);
    expect(row.windows.map((w) => w.label)).toEqual(["5h", "weekly", "monthly"]);
    expect(row.observedAt).toBeTypeOf("number");
  });

  test("not read yet is its own answer, not 0%", () => {
    __resetOpenCodeUsageCache();
    __resetOpenCodeSpend();
    // Point the stats read at a file that is not there: the machine this runs
    // on may have the CLI, and its real totals are not this test's answer.
    process.env.AGENTGLASS_OPENCODE_STATS = join(stateDir, "no-stats.json");
    try {
      const row = opencodeUsage(NOW);
      expect(row.available).toBe(false);
      expect(row.windows).toEqual([]);
      expect(row.note).toMatch(/No OpenCode worker turn on this PC/);
    } finally {
      delete process.env.AGENTGLASS_OPENCODE_STATS;
    }
  });

  test("a signed-out read stays unavailable with the reason", async () => {
    process.env.AGENTGLASS_OPENCODE_BROWSER = fakeBrowser(
      answer("Log in to OpenCode Console Continue with Google", "https://opencode.ai/console/login"),
    );
    const row = await refreshOpenCodeUsage(true);
    expect(row.available).toBe(false);
    expect(row.windows).toEqual([]);
    expect(row.note).toMatch(/not signed in/);
  });

  test("the CLI's plain read — title, url, then text — parses the same", async () => {
    process.env.AGENTGLASS_OPENCODE_BROWSER = fakeBrowser(
      "OpenCode Console\nhttps://opencode.ai/console/login\n\nLog in to OpenCode Console Continue with Google",
    );
    const row = await refreshOpenCodeUsage(true);
    expect(row.available).toBe(false);
    expect(row.note).toMatch(/not signed in/);
  });

  test("a browser that cannot run is unavailable, not a thrown route", async () => {
    process.env.AGENTGLASS_OPENCODE_BROWSER = "/nonexistent/agentglass-browser";
    const row = await refreshOpenCodeUsage(true);
    expect(row.available).toBe(false);
    expect(row.note).toMatch(/Could not run agentglass's browser/);
  });

  test("the cache is the ten-minute rule: a second ask inside it opens nothing", async () => {
    process.env.AGENTGLASS_OPENCODE_BROWSER = fakeBrowser(answer(CONSOLE_TEXT));
    await refreshOpenCodeUsage(true);
    writeFileSync(process.env.AGENTGLASS_TEST_OPENCODE_COUNT!, "");
    const again = await refreshOpenCodeUsage();
    expect(again.available).toBe(true);
    expect(readFileSync(process.env.AGENTGLASS_TEST_OPENCODE_COUNT!, "utf8")).toBe("");
    await refreshOpenCodeUsage(true);
    expect(readFileSync(process.env.AGENTGLASS_TEST_OPENCODE_COUNT!, "utf8")).not.toBe("");
  });

  test("a successful reading survives a restart, so the first snapshot is the plan's number", async () => {
    process.env.AGENTGLASS_OPENCODE_BROWSER = fakeBrowser(answer(CONSOLE_TEXT));
    const read = await refreshOpenCodeUsage(true);
    const file = join(stateDir, "opencode-console.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { at: number; windows: { usedPercent: number }[] };
    expect(Object.keys(raw).sort()).toEqual(["at", "windows"]);
    expect(raw.windows.map((w) => w.usedPercent)).toEqual([4, 1, 1]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Percentages and reset times only: the key lives in usagekey.ts.
    expect(readFileSync(file, "utf8")).not.toContain("key");

    // A restart forgets the in-memory reading; the file is what answers next.
    __resetOpenCodeUsageCache();
    const row = opencodeUsage();
    expect(row.calibration).toEqual({ at: raw.at, windows: read.windows });
  });

  test("a failed read keeps the last good reading on disk", async () => {
    process.env.AGENTGLASS_OPENCODE_BROWSER = fakeBrowser(answer(CONSOLE_TEXT));
    await refreshOpenCodeUsage(true);
    process.env.AGENTGLASS_OPENCODE_BROWSER = fakeBrowser(
      answer("Log in to OpenCode Console Continue with Google", "https://opencode.ai/console/login"),
    );
    await refreshOpenCodeUsage(true);
    __resetOpenCodeUsageCache();
    const row = opencodeUsage();
    expect(row.calibration?.windows.map((w) => w.usedPercent)).toEqual([4, 1, 1]);
  });
});

/*
 * The local windows. These are the numbers the panel draws, and they are the
 * only ones that can be checked without a login: a step's cost, its timestamp,
 * and the published dollar caps.
 */
describe("local spend windows", () => {
  const step = (at: number, cost: number): SpendStep => ({ at, cost, tokens: 10, key: `s:${at}:${cost}` });

  test("a rolling window sums the steps inside it against the published cap", () => {
    const steps = [step(NOW - 2 * 3600_000, 1.2), step(NOW - 6 * 86_400_000, 3)];
    expect(rollingWindow(steps, 300, NOW).usedPercent).toBe(10);       // $1.2 of $12
    expect(rollingWindow(steps, 10080, NOW).usedPercent).toBe(14);     // $4.2 of $30
    expect(rollingWindow(steps, 43200, NOW).usedPercent).toBe(7);      // $4.2 of $60
    // A step older than the window is out of it, and only that step.
    expect(rollingWindow([step(NOW - 6 * 86_400_000, 3)], 300, NOW).usedPercent).toBe(0);
  });

  test("the window resets when its oldest step falls out, not at a fixed hour", () => {
    const oldest = NOW - 2 * 3600_000;
    const w = rollingWindow([step(oldest, 1.2)], 300, NOW);
    expect(w.resetsAt).toBe(new Date(oldest + 300 * 60_000).toISOString());
    expect(rollingWindow([], 300, NOW).resetsAt).toBeNull();
  });

  test("a finished turn's step_finish events are recorded once, with their cost", () => {
    const out = join(stateDir, "out");
    writeFileSync(out, [
      JSON.stringify({ type: "step_start", timestamp: NOW - 1000, sessionID: "s1" }),
      JSON.stringify({ type: "step_finish", timestamp: NOW - 900, sessionID: "s1", part: { type: "step-finish", cost: 1.2, tokens: { input: 10, output: 5 } } }),
      JSON.stringify({ type: "step_finish", timestamp: NOW - 800, sessionID: "s1", part: { type: "step-finish", cost: 0.6, tokens: { output: 2 } } }),
    ].join("\n"));
    expect(recordOpenCodeTurn(out, NOW)).toBe(2);
    // The ceiling watch reads the same file again; nothing is counted twice.
    expect(recordOpenCodeTurn(out, NOW)).toBe(0);
    const row = opencodeUsage(NOW);
    expect(row.available).toBe(true);
    expect(row.source).toBe("this PC");
    expect(row.windows.find((w) => w.minutes === 300)!.usedPercent).toBe(15); // $1.8 of $12
    expect(row.windows.find((w) => w.minutes === 10080)!.usedPercent).toBe(6); // $1.8 of $30
    expect(row.observedAt).toBe(NOW - 800);
  });

  test("a step with no cost moves no dollar window", () => {
    const out = join(stateDir, "free");
    writeFileSync(out, JSON.stringify({ type: "step_finish", timestamp: NOW, sessionID: "s2", part: { type: "step-finish", cost: 0 } }));
    expect(recordOpenCodeTurn(out, NOW)).toBe(0);
    expect(opencodeUsage(NOW).available).toBe(false);
  });

  test("the row says its numbers cover this PC, not the plan", () => {
    const out = join(stateDir, "labelled");
    writeFileSync(out, JSON.stringify({ type: "step_finish", timestamp: NOW, sessionID: "s3", part: { type: "step-finish", cost: 1.2 } }));
    recordOpenCodeTurn(out, NOW);
    const row = opencodeUsage(NOW);
    expect(row.source).toBe("this PC");
    expect(row.note ?? "").not.toMatch(/whole plan/);
  });
});

/*
 * The engine's own stats, as measured on 31 Oct: `models[].model.id`, its
 * steps and cost, and `activity[]` by day. Read from a file here rather than
 * spawning the CLI, so the shape is what is pinned, not the machine.
 */
describe("per-model detail", () => {
  test("models and days come out of the local stats JSON", () => {
    const file = join(stateDir, "stats.json");
    writeFileSync(file, JSON.stringify({
      cost: 7.07, steps: 3953,
      models: [
        { model: { id: "model-a", providerID: "opencode-go" }, steps: 80, cost: 3.45, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 4 } } },
      ],
      activity: [{ date: "2026-10-31", steps: 3954 }],
    }));
    process.env.AGENTGLASS_OPENCODE_STATS = file;
    try {
      const d = openCodeDetail(30, true);
      expect(d?.models.map((m) => [m.model, m.steps, m.costUsd, m.tokens])).toEqual([["model-a", 80, 3.45, 20]]);
      expect(d?.daily[0]?.day).toBe("2026-10-31");
      expect(d?.costUsd).toBe(7.07);
    } finally {
      delete process.env.AGENTGLASS_OPENCODE_STATS;
    }
  });

  test("a shape it does not know answers nothing, not an empty table", () => {
    const file = join(stateDir, "stats-odd.json");
    writeFileSync(file, JSON.stringify({ models: [{ nope: true }], activity: [{}] }));
    process.env.AGENTGLASS_OPENCODE_STATS = file;
    try {
      expect(openCodeDetail(30, true)).toBeNull();
    } finally {
      delete process.env.AGENTGLASS_OPENCODE_STATS;
    }
  });
});

/*
 * An installed panel that says "none" while `opencode stats` knows the dollars
 * is the one empty-looking state this feature must not have. With no recorded
 * worker turn the row falls back to the engine's own totals, names the number
 * and says where it came from.
 */
describe("when this PC has no recorded step", () => {
  const statsFile = (cost: number): string => {
    const file = join(stateDir, "stats-total.json");
    writeFileSync(file, JSON.stringify({
      cost, steps: 3953,
      models: [{ model: { id: "model-a", providerID: "opencode-go" }, steps: 80, cost, tokens: { input: 10 } }],
      activity: [{ date: "2026-10-31", steps: 3953, tokens: 1200, cost }],
    }));
    return file;
  };

  test("the stats totals are the reading, named with their source", () => {
    __resetOpenCodeSpend();
    process.env.AGENTGLASS_OPENCODE_STATS = statsFile(7.07);
    try {
      const row = opencodeUsage(NOW);
      expect(row.available).toBe(true);
      expect(row.windows).toEqual([]);
      expect(row.spend).toEqual({ usd: 7.07, window: "30 days" });
      expect(row.source).toBe("opencode stats");
      expect(row.daily?.[0]?.tokens).toBe(1200);
    } finally {
      delete process.env.AGENTGLASS_OPENCODE_STATS;
    }
  });

  test("a worker turn already on disk is counted once, by its own dedupe key", () => {
    __resetOpenCodeSpend();
    const dir = join(stateDir, "worker-runs", "orbit-builder");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, "out");
    writeFileSync(out, [
      JSON.stringify({ type: "step_finish", timestamp: NOW - 60_000, sessionID: "s1", part: { cost: 3.5, tokens: { input: 10, output: 5 } } }),
      JSON.stringify({ type: "step_finish", timestamp: NOW - 30_000, sessionID: "s1", part: { cost: 1.25, tokens: { input: 4 } } }),
    ].join("\n"));
    const row = opencodeUsage(NOW);
    expect(row.available).toBe(true);
    expect(row.source).toBe("this PC");
    expect(row.windows.find((w) => w.minutes === 300)?.usedPercent).toBeGreaterThan(0);
    // A second read of the same folder adds nothing.
    expect(recordOpenCodeTurn(out, NOW)).toBe(0);
  });
});
