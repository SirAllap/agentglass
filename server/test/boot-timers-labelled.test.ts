// Every timer started on the boot path runs under a label, so the next "unlabelled" stall is not one.
// A raw setTimeout/setInterval in a boot file is allowed only when listed here, by name, with the reason.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (f: string) => readFileSync(join(import.meta.dir, "../src", f), "utf8");
/** Comments out, strings kept: a "setTimeout(" in prose must not count. */
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

// File -> the text of the raw calls that may stay, each with why.
const ALLOWED: Record<string, { call: RegExp; why: string }[]> = {
  "index.ts": [
    { call: /beat = setInterval\(/, why: "SSE keep-alive: one enqueue" },
    { call: /setInterval\(\(\) => waitedFor\("live ping sweep"/, why: "labelled inside" },
    { call: /setInterval\(\(\) => waitedFor\("ports sweep"/, why: "labelled inside" },
    { call: /setInterval\(\(\) => waitedFor\("parent liveness"/, why: "labelled inside" },
  ],
  "db.ts": [
    { call: /setInterval\(\(\) => \{\s*$/, why: "runs in the checkpoint worker thread" },
  ],
  "transcripts.ts": [
    { call: /setTimeout\(r, hot \? YIELD_HOT_MS : 0\)\)\.then\(\(\) => resumedAs/, why: "yield; the continuation sets its label" },
    { call: /setTimeout\(r, 200\)/, why: "waits for a busy flag, no work" },
    { call: /setTimeout\(r, coldPauseMs\(\)\)/, why: "pause between rescope chunks, no work" },
    { call: /timer = setTimeout\(\(\) => r\(false\), ms\)/, why: "deadline resolve" },
  ],
  "flightPlan.ts": [{ call: /setTimeout\(r, pauseMs\)/, why: "pause between plan-facts rows" }],
  "clickupwatch.ts": [{ call: /setInterval\(\(\) => \{ waitedFor\("clickup card watch"/, why: "labelled inside" }],
  "jirawatch.ts": [{ call: /setInterval\(\(\) => \{ waitedFor\("jira card watch"/, why: "labelled inside" }],
};
const BOOT_FILES = Object.keys(ALLOWED);

test("every timer in the boot files goes through setTimeoutAs/setIntervalAs, or is listed by name", () => {
  const bad: string[] = [];
  for (const f of BOOT_FILES) {
    const code = strip(src(f));
    for (const m of code.matchAll(/(^|[^A-Za-z.])(setTimeout|setInterval)\(/g)) {
      const at = m.index! + m[1]!.length;
      const line = code.slice(code.lastIndexOf("\n", at) + 1, code.indexOf("\n", at));
      const from = code.slice(code.lastIndexOf("\n", at) + 1, at + 160);
      if (!ALLOWED[f]!.some((a) => a.call.test(from) || a.call.test(line))) bad.push(`${f}: ${line.trim().slice(0, 110)}`);
    }
  }
  expect(bad).toEqual([]);
});

test("the labelled timers the boot path relies on are still labelled", () => {
  const idx = strip(src("index.ts"));
  for (const label of ["boot prune", "session path backfill", "hourly prune", "boot:plan-facts-backfill"]) expect(idx).toContain(`"${label}"`);
  expect(strip(src("db.ts"))).toContain('setTimeoutAs("boot:facets:slice"');
  // Work that resumes after an await names itself again.
  expect(strip(src("transcripts.ts"))).toContain("resumedAs(SCAN_LABEL)");
  expect(strip(src("db.ts"))).toContain('resumedAs("cold events pace")');
});
