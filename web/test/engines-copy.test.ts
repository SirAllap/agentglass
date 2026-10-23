/*
 * The Agent engines page, held without a renderer: the sentences are pure
 * functions of what the server measured, so the table below IS the contract
 * (docs of the page: eight states, one badge, one action, one first row each),
 * and the layout rules are asserted against the component's source.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { EngineReadiness } from "../../shared/types.ts";
import { accountText, actionOf, agoWords, badgeOf, engineCounts, engineState, firstRow, logoOf, reportingCheck, tileChecks, versionLine, versionText } from "../src/components/engines/enginesCopy.ts";

import { readEngines } from "../src/components/engines/readEngines.ts";

const NOW = 1_800_000_000_000;

// The shape the server returns for a ready engine; each case changes what it must.
const ready = (over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id: "orbit", title: "Orbit", found: true, path: "/usr/bin/orbit", version: "2.1.296", min: null, versionOk: true,
  account: { signedIn: true, provider: "Nous Portal" },
  answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: false, why: "Cannot orchestrate yet: agentglass does not know how to read Orbit's screen." } },
  missing: [], envelope: { via: "own-config", enforced: "partly", note: "Refuses git push: yes." },
  ...over,
});

const CASES: { name: string; e: EngineReadiness | null; badge: [string, string]; action: [string, boolean]; first: string; command?: string }[] = [
  { name: "checking", e: null, badge: ["checking", "Checking"], action: ["Recheck", true], first: "Looking for it on this machine." },
  {
    name: "not on this machine",
    e: ready({ found: false, path: null, version: null, versionOk: null, missing: [{ kind: "command", what: "Install Orbit.", command: "npm i -g orbit-cli" }] }),
    badge: ["off", "Not installed"], action: ["Recheck", false], first: "Not on this machine.", command: "npm i -g orbit-cli",
  },
  {
    name: "installed, too old",
    e: ready({ version: "0.21.0", min: "0.21.4", versionOk: false, missing: [{ kind: "command", command: "orbit update", what: "0.21.0 is installed. agentglass needs 0.21.4 or later: it is the first with the output format agentglass reads." }] }),
    badge: ["warn", "Needs update"], action: ["Recheck", false],
    first: "0.21.0 is installed. agentglass needs 0.21.4 or later: it is the first with the output format agentglass reads.", command: "orbit update",
  },
  {
    name: "version fails to run",
    e: ready({ version: null, versionOk: null, missing: [{ kind: "manual", what: "Orbit does not run: ModuleNotFoundError: No module named 'orbit_cli'. Try `orbit --version` in a terminal." }] }),
    badge: ["err", "Not working"], action: ["Recheck", false],
    first: "Orbit does not run: ModuleNotFoundError: No module named 'orbit_cli'. Try `orbit --version` in a terminal.",
  },
  {
    name: "no account",
    e: ready({ account: { signedIn: false }, missing: [{ kind: "login", what: "Not signed in to Orbit.", command: "orbit login" }] }),
    badge: ["warn", "Needs sign-in"], action: ["Recheck", false], first: "Not signed in.", command: "orbit login",
  },
  { name: "ready, never tested", e: ready(), badge: ["ok", "Ready"], action: ["Test", false], first: "Not tested yet. Test sends one word and costs one small turn." },
  {
    name: "ready, tested",
    e: ready({ answers: { state: "ok", at: NOW - 2 * 3_600_000, ms: 3100 } }),
    badge: ["ok", "Ready"], action: ["Test", false], first: "Answered in 3 s, 2 hours ago.",
  },
  {
    name: "test failed",
    e: ready({ answers: { state: "failed", at: NOW - 60_000, ms: 800, error: "Error: rate limit reached, try again later" } }),
    badge: ["err", "Not answering"], action: ["Test", false], first: "Error: rate limit reached, try again later",
  },
  {
    name: "version probe timed out",
    e: ready({ version: null, versionOk: null, slow: true, missing: [{ kind: "manual", what: "Orbit did not answer `orbit --version` within 15 s." }] }),
    badge: ["checking", "Checking"], action: ["Recheck", false], first: "Still checking: the version is slow to answer.",
  },
];

describe("the eight states of an engine card", () => {
  for (const c of CASES) {
    test(c.name, () => {
      expect(badgeOf(c.e)).toEqual({ tone: c.badge[0] as never, text: c.badge[1] });
      expect(actionOf(c.e)).toEqual({ label: c.action[0] as never, disabled: c.action[1] });
      const r = firstRow(c.e, NOW);
      expect(r.text).toBe(c.first);
      expect(r.command).toBe(c.command);
    });
  }

  test("a sign-in row says the password is never seen", () => {
    expect(firstRow(CASES[4]!.e, NOW).hint).toBe("Run it in a terminal; agentglass does not see the password.");
  });

  test("a test in flight is Testing, with the action held", () => {
    const e = ready({ answers: { state: "running" } });
    expect(engineState(e)).toBe("testing");
    expect(actionOf(e)).toEqual({ label: "Test", disabled: true });
  });

  test("an optional sign-in that is absent is still Ready", () => {
    // OpenCode's free catalogue needs none: the probe adds no login fix.
    expect(engineState(ready({ account: { signedIn: false } }))).toBe("ready");
  });
});

describe("a slow engine is asked about again, once", () => {
  const rep = (slow: boolean) => ({ host: "h", engines: [ready({ versionOk: slow ? null : true, ...(slow ? { slow } : {}) })] });
  const run = async (answers: boolean[]) => {
    const asked: boolean[] = [];
    const shown: boolean[] = [];
    const waits: number[] = [];
    await readEngines(
      async (fresh) => { asked.push(fresh); return rep(answers[asked.length - 1] ?? true); },
      (r) => shown.push(!!r.engines[0].slow),
      { wait: async (ms) => { waits.push(ms); } },
    );
    return { asked, shown, waits };
  };
  test("slow then fine: one fresh retry after a wait", async () => {
    expect(await run([true, false])).toEqual({ asked: [false, true], shown: [true, false], waits: [4000] });
  });
  test("still slow: no third ask", async () => {
    expect((await run([true, true])).asked).toEqual([false, true]);
  });
  test("not slow: no retry, no wait", async () => {
    expect(await run([false])).toEqual({ asked: [false], shown: [false], waits: [] });
  });
});

describe("the rows", () => {
  test("version says what is needed only when it is old", () => {
    expect(versionText(ready())).toBe("2.1.296");
    expect(versionText(ready({ version: "0.21.0", min: "0.21.4", versionOk: false }))).toBe("0.21.0 · needs 0.21.4");
    expect(versionText(ready({ found: false, version: null }))).toBe("Not installed");
  });

  test("account and model name providers and models, never more", () => {
    expect(accountText(ready({ account: { signedIn: true, provider: "Nous Portal", model: "nous/space-bunny-alpha" } }))).toBe("Nous Portal · nous/space-bunny-alpha");
    expect(accountText(ready({ account: { signedIn: true, provider: "firstParty", account: "claude.ai" } }))).toBe("Signed in with claude.ai");
    expect(accountText(ready({ account: { signedIn: false } }))).toBe("Not signed in");
    expect(accountText(ready({ account: { signedIn: null } }))).toBe("Sign-in is not checked");
  });

  test("time reads in words", () => {
    expect(agoWords(NOW - 5_000, NOW)).toBe("just now");
    expect(agoWords(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(agoWords(NOW - 3 * 3_600_000, NOW)).toBe("3 hours ago");
    expect(agoWords(NOW - 2 * 86_400_000, NOW)).toBe("2 days ago");
  });
});

describe("the component", () => {
  const pane = readFileSync(new URL("../src/components/engines/EnginesPane.tsx", import.meta.url), "utf8");
  const code = pane.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  test("the badge and the action are in the tile, whatever the state", () => {
    // One tile per engine, built with both from the same functions the table
    // above holds; there is no branch that omits them.
    const tile = code.slice(code.indexOf("function EngineTile("), code.indexOf("function AddCli("));
    expect(tile).toMatch(/<StatusBadge tone=\{badge\.tone\}>\{badge\.text\}<\/StatusBadge>/);
    expect(tile).toContain("<Button disabled={act.disabled} onClick={act.label === \"Test\" ? onTest : onRecheck}>{act.label}</Button>");
    expect(tile).toContain("badgeOf(e)");
    expect(tile).toContain("actionOf(e)");
  });

  test("while checking every row is there at its final height", () => {
    // The tile is built from `e === null` exactly as from an answer: the same
    // five checks with `…` where a value goes, so nothing jumps when it arrives.
    expect(tileChecks(null, NOW, reportingCheck(null, false, NOW))).toHaveLength(5);
    expect(tileChecks(ready(), NOW, reportingCheck(null, true, NOW))).toHaveLength(5);
    const tile = code.slice(code.indexOf("function EngineTile("), code.indexOf("function AddCli("));
    expect(tile).toContain("reportingLoaded");
    expect(tile).toContain('e ? versionText(e) : "…"');
  });

  test("no page polls: it loads on open and on Recheck", () => {
    for (const f of ["EnginesPane.tsx", "ReportingRow.tsx", "enginesCopy.ts"]) {
      const src = readFileSync(new URL(`../src/components/engines/${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/usePoll|setInterval|setTimeout/);
    }
    expect(code).toContain("useEffect(() => { load(); }, [load]);");
  });

  test("the one-line test runs only from a press", () => {
    // `test(` is called from the Button's handler and from nowhere else.
    expect(code.match(/void test\(/g)!.length).toBe(1);
    expect(code).toContain("onClick={act.label === \"Test\" ? onTest : onRecheck}");
  });

  test("engines that are not installed are tiles of their own, behind the same filter", () => {
    expect(code).toContain('{ v: "absent", label: `Not installed ${counts.absent}` }');
    expect(code).toContain("<AddCli />");
  });

  test("the header says the same three numbers the filter does", () => {
    expect(code).toContain("useReportHead(\"engines\"");
    expect(code).toContain("`${counts.ready} ready`");
    expect(code).toContain("`${counts.absent} not installed`");
  });

  test("what a worker is held to is not promised as a wall: the lock is rules over a command line", () => {
    const row = pane.slice(pane.indexOf("Held to its own worktree"));
    const hint = row.slice(0, row.indexOf("</p>"));
    expect(hint).toContain("not a sandbox");
    expect(hint).not.toMatch(/always|never|cannot/);
  });

  test("the old Agents list is a link to this page, not a second list", () => {
    const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
    expect(modal).toContain('<WorkerRolesCard open={open} resetTick={resetTick} onEngines={() => openSettings("engines")} />');
    expect(modal).not.toContain("Other agents on this machine");
  });
});

describe("the tiles' words", () => {
  test("counts: ready, need you and not installed are the page header's and the filter's", () => {
    expect(engineCounts(["ready", "ready", "signin", "old", "missing", "checking"])).toEqual({ all: 6, ready: 2, needs: 2, absent: 1 });
    expect(engineCounts([])).toEqual({ all: 0, ready: 0, needs: 0, absent: 0 });
  });

  test("the checklist: what is fine, what wants a hand, what is simply absent", () => {
    const rep = reportingCheck({ found: true, connected: true, seenAt: NOW - 120_000 }, true, NOW);
    expect(rep).toEqual({ state: "ok", label: "Reports here", value: "Last event 2 minutes ago" });
    expect(reportingCheck({ found: true, connected: true, seenAt: null }, true, NOW).state).toBe("warn");
    expect(reportingCheck({ found: true, connected: false, seenAt: null }, true, NOW).value).toBe("Not connected");
    expect(reportingCheck({ found: false, connected: false, seenAt: null }, true, NOW).state).toBe("no");
    expect(reportingCheck(null, false, NOW).value).toBe("…");
    const rows = tileChecks(ready({ account: { signedIn: false } }), NOW, rep);
    expect(rows.map((r) => [r.label, r.state])).toEqual([["Installed", "ok"], ["Signed in", "warn"], ["Reports here", "ok"], ["Can be used as", "ok"], ["Last test", "no"]]);
    expect(rows[3]!.value).toBe("worker");
    expect(tileChecks(ready({ answers: { state: "ok", at: NOW - 5000, ms: 2400 } }), NOW, rep)[4]).toEqual({ state: "ok", label: "Last test", value: "2 s, just now" });
    expect(tileChecks(ready({ answers: { state: "failed", error: "No answer" } }), NOW, rep)[4]!.state).toBe("warn");
  });

  test("the line under the name is the version, or why there is none", () => {
    expect(versionLine(null)).toBe("Checking…");
    expect(versionLine(ready())).toBe("2.1.296");
    expect(versionLine(ready({ found: false, path: null, version: null }))).toBe("Not on this machine");
    expect(versionLine(ready({ version: "0.21.0", min: "0.21.4", versionOk: false }))).toBe("0.21.0 · needs 0.21.4");
  });

  test("every engine has a logo colour, and an unknown one a quiet grey", () => {
    for (const id of ["claude", "codex", "gemini", "opencode", "hermes", "antigravity"]) expect(logoOf(id)).toMatch(/^#[0-9a-f]{6}$/);
    expect(logoOf("unheard-of")).toBe("#8a8497");
  });
});
