import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Every recurring server timer needs a reason. Sites are counted per file: a
// new setInterval fails here until the file's max is raised with a reason. A
// setTimeout that re-arms itself is a setInterval in disguise (the old
// armOpenToolsTick shape), so it is counted too, by function name.
const ALLOWED: Record<string, { max: number; why: string }> = {
  "transcripts.ts": { max: 2, why: "fs-watch fallback poll and reconcile net" },
  "tmuxrestore.ts": { max: 1, why: "layout capture, no tmux event" },
  "tmuxpane.ts": { max: 1, why: "idle pane eviction" },
  "tmuxctl.ts": { max: 1, why: "mirror sweep" },
  "tasks.ts": { max: 1, why: "task sweeper" },
  "agents/tuiturn.ts": { max: 1, why: "per-turn wait, ends with the turn" },
  "clickupwatch.ts": { max: 1, why: "remote API poll" },
  "jirawatch.ts": { max: 1, why: "remote API poll" },
  "dockerlive.ts": { max: 1, why: "SSE heartbeat" },
  "gitwork.ts": { max: 1, why: "auto-fetch, audience-gated" },
  "finderactions.ts": { max: 1, why: "per-job progress read" },
  "scopes.ts": { max: 1, why: "scope sweep" },
  "orphans.ts": { max: 1, why: "orphan sampler" },
  "lanes.ts": { max: 1, why: "lane sweep" },
  "loopwatch.ts": { max: 3, why: "event-loop drift meter, the labelled setIntervalAs wrapper, and the stall sampler worker's tick (worker thread)" },
  "db.ts": { max: 1, why: "checkpoint worker's tick, inside the worker source string (worker thread, not the server loop)" },
  "agents/nextCard.ts": { max: 1, why: "remote next-card poll" },
  "polaris.ts": { max: 1, why: "polaris sweep" },
  "ratelimit.ts": { max: 1, why: "bucket eviction" },
  "pricing.ts": { max: 1, why: "daily remote refresh" },
  "reaper.ts": { max: 1, why: "reaper" },
  "prWatch.ts": { max: 2, why: "PR re-ask, live-client gated" },
  "index.ts": { max: 7, why: "ws ping sweep, SSE heartbeat, prune, ports, slice retry, snapshot guard, parent liveness" },
};

const SELF_REARM: Record<string, string> = {
  "loopwatch.ts:close": "one-shot 60 s cap on an open boot label, unref'd",
  "agentprobe.ts:kill": "one-shot kill escalation",
  "broker/brokerHost.ts:launch": "restart backoff",
  "checkOnBase.ts:stop": "one-shot stop escalation",
  "childledger.ts:finish": "one-shot settle",
  "clickup.ts:drainOneCount": "bounded drain",
  "clickupindex.ts:step": "bounded index walk",
  "clickupwatch.ts:tick": "remote API poll",
  "browserGuide.ts:done": "one deadline per guide next, settles once",
  "db.ts:step": "bounded free-page shrink",
  "gitwork.ts:step": "bounded fetch walk",
  "index.ts:more": "bounded retry",
  "index.ts:boot": "start-up retry",
  "index.ts:watchTailnet": "tailnet status poll",
  "jirawatch.ts:tick": "remote API poll",
  "ownhelpers.ts:settle": "one-shot settle",
  "plugin-ui.ts:done": "one-shot settle",
  "reader/readerHost.ts:launch": "restart backoff",
  "relay/relayHost.ts:launch": "restart backoff",
  "relay/termrelay.ts:flush": "output coalescing",
  "selfupdate.ts:clearLock": "one-shot lock expiry",
  "spawnOut.ts:kill": "one-shot kill escalation",
  "spawnpool.ts:release": "one-shot release",
  "terminal.ts:arm": "idle timer, re-armed by input",
  "terminal.ts:flush": "output coalescing",
  "terminal.ts:put": "output coalescing",
  "tmuxwatch.ts:kill": "one-shot kill escalation",
  "volumes.ts:run": "bounded volume walk",
};

function walk(dir: string, base = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), base + e.name + "/") : e.name.endsWith(".ts") ? [base + e.name] : []);
}

/** Names of functions whose own body arms a setTimeout that calls them again. */
export function selfRearmers(src: string): string[] {
  const out = new Set<string>();
  const re = /\bsetTimeout\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const decls = [...src.slice(0, m.index).matchAll(/(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\())/g)];
    const d = decls[decls.length - 1];
    if (!d) continue;
    const name = d[1] ?? d[2];
    let depth = 0;
    const open = m.index + m[0].length - 1;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    if (new RegExp(`\\b${name}\\s*\\(\\s*\\)|^\\(\\s*${name}\\s*[,)]`).test(src.slice(open, end))) out.add(name);
  }
  return [...out];
}

const root = join(import.meta.dir, "../src");
const sources = walk(root).map((f) => [f, readFileSync(join(root, f), "utf8")] as const);

test("setInterval sites per file stay within the allow-listed count", () => {
  const over = sources
    .map(([f, s]) => [f, (s.match(/\bsetInterval\s*\(/g) ?? []).length] as const)
    .filter(([f, n]) => n > (ALLOWED[f]?.max ?? 0))
    .map(([f, n]) => `${f}: ${n} > ${ALLOWED[f]?.max ?? 0}`);
  expect(over).toEqual([]);
});

test("a setTimeout that re-arms itself is allow-listed with a reason", () => {
  const bad = sources.flatMap(([f, s]) => selfRearmers(s).map((n) => `${f}:${n}`)).filter((k) => !(k in SELF_REARM));
  expect(bad).toEqual([]);
});

test("the self re-arm scan catches the old armOpenToolsTick shape", () => {
  const old = "function armOpenToolsTick() {\n  setTimeout(() => { void pushOpenTools(); armOpenToolsTick(); }, 4000);\n}";
  expect(selfRearmers(old)).toEqual(["armOpenToolsTick"]);
  expect(selfRearmers("function once() { setTimeout(() => other(), 5); }")).toEqual([]);
});

test("pushOpenTools has no fixed interval", () => {
  const t = readFileSync(join(import.meta.dir, "../src/openToolsTick.ts"), "utf8");
  expect(t).not.toMatch(/setInterval/);
});
