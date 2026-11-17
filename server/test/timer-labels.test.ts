import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Every timer the server starts must run under a label the stall watcher reads
// (setTimeoutAs / setIntervalAs / waitedFor / bootStep), or say why not with a
// "loop-ok:" note. A bare one shows up as "unlabelled ... computing" with no name.
// Unlabelled one-shots that exist today are counted per file in BASELINE; a new
// one in any file fails here. Lower a number when you label one; never raise it.
const SRC = join(import.meta.dir, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

/** Lines with a bare setInterval/setTimeout call: not a comment, not labelled, not marked loop-ok. */
export function bareTimers(src: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  lines.forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, "").trim();
    if (!code || code.startsWith("*") || code.startsWith("/*")) return;
    if (!/(?<![\w.])(setInterval|setTimeout)\s*\(/.test(code)) return;
    if (/loop-ok/.test(raw) || /loop-ok/.test(lines[i - 1] ?? "")) return;
    if (/waitedFor\(|bootStep\(/.test(code)) return;
    out.push(`${i + 1}: ${code.slice(0, 100)}`);
  });
  return out;
}

const BASELINE: Record<string, number> = {
  "agentprobe.ts": 1,
  "agents/opencodeserve.ts": 1,
  "bench.ts": 4,
  "broker/brokerMain.ts": 2,
  "browserdrive.ts": 6,
  "checkOnBase.ts": 1,
  "childledger.ts": 1,
  "clickup.ts": 6,
  "disk.ts": 1,
  "editor.ts": 2,
  "editorwhere.ts": 1,
  "enginemodels.ts": 1,
  "finderactions.ts": 1,
  "flightBudget.ts": 4,
  "flightPlan.ts": 1,
  "fsops.ts": 3,
  "git.ts": 1,
  "homeindex.ts": 1,
  "jira.ts": 2,
  "jiraFiles.ts": 1,
  "mediafacts.ts": 1,
  "ownhelpers.ts": 1,
  "plugin-catalogue.ts": 1,
  "plugin-socket.ts": 1,
  "plugin-ui.ts": 1,
  "plugins.ts": 1,
  "polaris.ts": 1,
  "prs.ts": 6,
  "relay/termrelay.ts": 2,
  "remotes.ts": 2,
  "secretservice.ts": 1,
  "setupscan.ts": 1,
  "spawnpool.ts": 1,
  "spend.ts": 1,
  "terminal.ts": 1,
  "themesync.ts": 2,
  "transcripts.ts": 5,
  "treeAt.ts": 1,
};

test("scanner flags a bare timer and skips labelled, noted and commented ones", () => {
  const src = [
    "setInterval(() => work(), 5);",
    "setIntervalAs(\"x\", () => work(), 5);",
    "setTimeout(() => waitedFor(\"y\", work), 5);",
    "// setTimeout(() => work(), 5);",
    "setTimeout(done, 5); // loop-ok: one resolve",
    "// loop-ok: relaunch",
    "setTimeout(launch, 5);",
  ].join("\n");
  expect(bareTimers(src)).toEqual(["1: setInterval(() => work(), 5);"]);
});

test("no new unlabelled setInterval/setTimeout in server/src", () => {
  const found: Record<string, number> = {};
  const intervals: string[] = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    if (rel === "loopwatch.ts") continue;
    const bare = bareTimers(readFileSync(f, "utf8"));
    if (bare.length) found[rel] = bare.length;
    for (const b of bare) if (b.includes("setInterval")) intervals.push(`${rel}:${b}`);
  }
  // A repeating timer is never allowed bare: it is the periodic work the watcher must name.
  expect(intervals).toEqual([]);
  const grew = Object.entries(found).filter(([k, n]) => n > (BASELINE[k] ?? 0)).map(([k, n]) => `${k}: ${n} (allowed ${BASELINE[k] ?? 0})`);
  expect(grew).toEqual([]);
});
