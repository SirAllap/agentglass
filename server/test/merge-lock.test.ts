/*
 * The merge lock: a PR that GitHub would merge today and the person says must
 * wait (step 2b of a rollout lands only once step 2a is on production).
 *
 * The pure part is asserted here directly. The rest runs the real functions in
 * a child process whose PATH has a `gh` that only writes down its argv (the
 * server resolves `gh` once at start), against its own database: nothing here
 * can reach or merge a real pull request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanLockInput, lockDateLabel, mergeLockState, type MergeLock } from "../../shared/mergeLock.ts";

const NOW = new Date(2026, 10, 23, 12, 0).getTime();
const LATER = new Date(2026, 10, 25, 9, 0).getTime();
const lock = (over: Partial<MergeLock> = {}): MergeLock => ({
  repo: "github.com/orbit/api", number: 1042, until: null, items: [], note: "", afterPr: null, setAt: NOW, updatedAt: NOW, ...over,
});
const item = (done: boolean) => ({ id: "a", text: "step 2a is on production", done });

describe("lock evaluation", () => {
  test("no lock: unlocked, no sentence", () => {
    expect(mergeLockState(null, NOW)).toMatchObject({ locked: false, reason: "" });
  });
  test("date ahead: locked with the date; date passed: unlocked", () => {
    expect(lockDateLabel(LATER)).toBe("Wed 25 Nov 09:00");
    expect(mergeLockState(lock({ until: LATER }), NOW)).toMatchObject({ locked: true, reason: "Locked until Wed 25 Nov 09:00" });
    expect(mergeLockState(lock({ until: LATER }), LATER).locked).toBe(false);
  });
  test("items: locked until every item is ticked", () => {
    const two = lock({ items: [item(true), { id: "b", text: "copy dry run reviewed", done: false }] });
    expect(mergeLockState(two, NOW)).toMatchObject({ locked: true, reason: "Locked — 1 of 2 items ticked", ticked: 1, total: 2 });
    expect(mergeLockState(lock({ items: [item(true)] }), NOW).locked).toBe(false);
  });
  test("both: each must hold", () => {
    expect(mergeLockState(lock({ until: LATER, items: [item(false)] }), NOW).reason).toBe("Locked until Wed 25 Nov 09:00 — 0 of 1 item ticked");
    expect(mergeLockState(lock({ until: LATER, items: [item(true)] }), NOW).reason).toBe("Locked until Wed 25 Nov 09:00 — 1 of 1 item ticked");
    expect(mergeLockState(lock({ until: LATER, items: [item(false)] }), LATER).reason).toBe("Locked — 0 of 1 item ticked");
    expect(mergeLockState(lock({ until: LATER, items: [item(true)] }), LATER).locked).toBe(false);
  });
  test("after another PR: unknown or open keeps it shut, merged opens it", () => {
    expect(mergeLockState(lock({ afterPr: 1041 }), NOW).reason).toBe("Locked — waiting for #1041 to merge");
    expect(mergeLockState(lock({ afterPr: 1041 }), NOW, false).locked).toBe(true);
    expect(mergeLockState(lock({ afterPr: 1041 }), NOW, true).locked).toBe(false);
  });
  test("input: an empty lock, a bad date and a self-wait are refused", () => {
    expect(cleanLockInput({}, 1042)).toMatchObject({ ok: false });
    expect(cleanLockInput({ until: "not a date" }, 1042)).toMatchObject({ ok: false });
    expect(cleanLockInput({ afterPr: "#1042" }, 1042)).toMatchObject({ ok: false });
    expect(cleanLockInput({ items: [{ text: "  " }, { text: "step 2a is on production" }] }, 1042)).toMatchObject({ ok: true, items: [{ text: "step 2a is on production", done: false }] });
  });
});

const ROOT = "gh:orbit/api";
let dir: string;
let first: Record<string, { res: any; argv: string[] }>;
let second: Record<string, { res: any; argv: string[] }>;

async function child(dbDir: string, log: string, cases: [string, string][]): Promise<Record<string, { res: any; argv: string[] }>> {
  const script = `
    import * as P from ${JSON.stringify(new URL("../src/prs.ts", import.meta.url).pathname)};
    import { mergeLockWrite, gateMergeLock } from ${JSON.stringify(new URL("../src/mergeLockRoutes.ts", import.meta.url).pathname)};
    import { outwardAction } from ${JSON.stringify(new URL("../src/outward.ts", import.meta.url).pathname)};
    const G = (tool, input) => gateMergeLock(tool, input, outwardAction(tool, input), "/nowhere");
    import { readFileSync, writeFileSync } from "node:fs";
    const R = ${JSON.stringify(ROOT)}, log = ${JSON.stringify(log)};
    const W = (path, b, person = true, now) => mergeLockWrite(path, { root: R, number: 1042, ...b }, person, "person", now);
    const cases = [${cases.map(([n, c]) => `[${JSON.stringify(n)}, () => ${c}]`).join(",")}];
    const out = {};
    for (const [name, run] of cases) {
      writeFileSync(log, "");
      const res = await run();
      out[name] = { res, argv: readFileSync(log, "utf8").split("\\n").filter(Boolean) };
    }
    console.log("RESULT " + JSON.stringify(out));
  `;
  const p = Bun.spawn(["bun", "-e", script], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, NODE_ENV: "test", HOME: dbDir,
      XDG_CONFIG_HOME: dbDir, XDG_DATA_HOME: dbDir, XDG_CACHE_HOME: dbDir,
      AGENTGLASS_STATE_DIR: join(dbDir, "state"), AGENTGLASS_DB: join(dbDir, "a.db"), TMUX_TMPDIR: dbDir, TMPDIR: tmpdir(),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const line = so.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`child gave no result:\n${so}\n${se}`);
  return JSON.parse(line.slice(7));
}

const SOON = "Date.now() + 120000";
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-merge-lock-"));
  const log = join(dir, "gh.log");
  mkdirSync(join(dir, "bin"));
  /* `pr view 1041 --json state` answers MERGED; any other view, OPEN. */
  writeFileSync(join(dir, "bin", "gh"), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in\n  "pr view 1041 "*) echo '{"state":"MERGED"}' ;;\n  "pr view "*) echo '{"state":"OPEN"}' ;;\n  *) echo ok ;;\nesac\n`);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  first = await child(dir, log, [
    ["agent sets", `W("/prs/merge-lock", { until: ${SOON}, items: [{ text: "step 2a is on production" }] }, false)`],
    ["set", `W("/prs/merge-lock", { until: ${SOON}, items: [{ id: "a", text: "step 2a is on production" }], note: "step 2b" })`],
    ["squash", `P.mergePr(R, 1042, "squash", {})`],
    ["rebase", `P.mergePr(R, 1042, "rebase", { deleteBranch: true })`],
    ["auto", `P.mergePr(R, 1042, "merge", { auto: true })`],
    ["cancel auto", `P.mergePr(R, 1042, "merge", { disableAuto: true })`],
    ["update branch", `P.updateBranch(R, 1042)`],
    ["other pr", `P.mergePr(R, 7, "squash", {})`],
    ["gate shell", `G("Bash", { command: "gh pr merge 1042 --squash -R orbit/api" })`],
    ["gate shell cancel auto", `G("Bash", { command: "gh pr merge 1042 --disable-auto -R orbit/api" })`],
    ["gate shell other pr", `G("Bash", { command: "gh pr merge 7 --squash -R orbit/api" })`],
    ["gate mcp", `G("mcp__github__merge_pull_request", { owner: "orbit", repo: "api", pull_number: "1042" })`],
    ["agent ticks", `W("/prs/merge-lock/tick", { itemId: "a" }, false)`],
    ["agent unlocks", `W("/prs/merge-lock/unlock", { confirm: "1042" }, false)`],
    ["tick", `W("/prs/merge-lock/tick", { itemId: "a" })`],
    ["after tick", `P.mergePr(R, 1042, "squash", {})`],
    ["unlock untyped", `W("/prs/merge-lock/unlock", { confirm: "yes" })`],
  ]);
  /* A second process on the same database: the app restarted. */
  second = await child(dir, log, [
    ["read", `P.mergeLockOf(R, 1042)`],
    ["still refused", `P.mergePr(R, 1042, "squash", {})`],
    ["list", `P.mergeLocksOf(R)`],
    ["date passed", `W("/prs/merge-lock", { until: Date.now() - 1000, items: [{ id: "a", text: "step 2a is on production", done: true }] })`],
    ["merge now", `P.mergePr(R, 1042, "squash", {})`],
    ["wait for open", `W("/prs/merge-lock", { afterPr: 1040 })`],
    ["refused open", `P.mergePr(R, 1042, "squash", {})`],
    ["wait for merged", `W("/prs/merge-lock", { afterPr: 1041 })`],
    ["merge after", `P.mergePr(R, 1042, "squash", {})`],
    ["relock", `W("/prs/merge-lock", { until: Date.now() + 3600000 })`],
    ["unlock now", `W("/prs/merge-lock/unlock", { confirm: "#1042" })`],
    ["merge unlocked", `P.mergePr(R, 1042, "squash", {})`],
  ]);
}, 60_000);

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const merged = (argv: string[]) => argv.filter((l) => /^pr merge 1042 --(squash|merge|rebase)/.test(l));
const REASON = /^Locked until \w{3} \d{1,2} \w{3} \d{2}:\d{2} — 0 of 1 item ticked$/;

describe("every merge refused while locked", () => {
  test("an agent cannot set a lock", () => {
    expect(first["agent sets"]!.res).toMatchObject({ ok: false, status: 403 });
  });
  test("squash, rebase and auto-merge are refused with the one sentence, gh never asked to merge", () => {
    expect(first.set!.res.state.locked).toBe(true);
    for (const k of ["squash", "rebase", "auto"]) {
      expect(first[k]!.res.ok).toBe(false);
      expect(first[k]!.res.error).toMatch(REASON);
      expect(merged(first[k]!.argv)).toEqual([]);
    }
  });
  test("cancelling auto-merge and updating the branch stay allowed", () => {
    expect(first["cancel auto"]!.argv).toContain("pr merge 1042 --disable-auto -R orbit/api");
    expect(first["update branch"]!.argv.some((l) => l.includes("pr update-branch 1042"))).toBe(true);
  });
  test("another PR of the same repository is not locked", () => {
    expect(first["other pr"]!.argv.some((l) => l.startsWith("pr merge 7 --squash"))).toBe(true);
  });
  test("an agent's own gh pr merge or GitHub MCP merge is refused at the gate; cancelling auto-merge and other PRs pass", () => {
    expect(first["gate shell"]!.res).toMatch(/^merge lock on #1042: Locked until /);
    expect(first["gate mcp"]!.res).toMatch(/^merge lock on #1042: Locked until /);
    expect(first["gate shell cancel auto"]!.res).toBeNull();
    expect(first["gate shell other pr"]!.res).toBeNull();
  });
  test("an agent cannot tick an item or unlock", () => {
    expect(first["agent ticks"]!.res).toMatchObject({ ok: false, status: 403 });
    expect(first["agent unlocks"]!.res).toMatchObject({ ok: false, status: 403 });
  });
  test("ticked but the date is ahead: still refused", () => {
    expect(first.tick!.res.state).toMatchObject({ locked: true, ticked: 1, total: 1 });
    expect(first["after tick"]!.res.error).toMatch(/^Locked until .* — 1 of 1 item ticked$/);
    expect(merged(first["after tick"]!.argv)).toEqual([]);
  });
  test("Unlock now needs the PR number typed", () => {
    expect(first["unlock untyped"]!.res).toMatchObject({ ok: false, error: "type 1042 to unlock now" });
  });
});

describe("after a restart", () => {
  test("the lock is still there and still refuses", () => {
    expect(second.read!.res.lock).toMatchObject({ number: 1042, note: "step 2b", items: [{ text: "step 2a is on production", done: true }] });
    expect(second["still refused"]!.res.ok).toBe(false);
    expect(merged(second["still refused"]!.argv)).toEqual([]);
    expect(second.list!.res).toHaveLength(1);
  });
  test("date passed and all ticked: the merge goes to gh", () => {
    expect(second["date passed"]!.res.state.locked).toBe(false);
    expect(merged(second["merge now"]!.argv)).toEqual(["pr merge 1042 --squash -R orbit/api"]);
  });
  test("after #n: open keeps it shut, merged opens it", () => {
    expect(second["refused open"]!.res.error).toBe("Locked — waiting for #1040 to merge");
    expect(merged(second["refused open"]!.argv)).toEqual([]);
    expect(merged(second["merge after"]!.argv)).toHaveLength(1);
  });
  test("Unlock now lifts it and the merge goes through", () => {
    expect(second["unlock now"]!.res).toMatchObject({ ok: true, lock: null });
    expect(merged(second["merge unlocked"]!.argv)).toHaveLength(1);
  });
});

describe("one door for every merge", () => {
  test("`pr merge` is sent only from mergePr, which checks the lock first; the route refuses agents on writes", async () => {
    const prs = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();
    const idx = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(prs.match(/\["pr", "merge"/g)).toHaveLength(2);
    const body = prs.slice(prs.indexOf("export async function mergePr("), prs.indexOf("export async function closePr(") > 0 ? prs.indexOf("/* \"After #n is merged\"") : undefined);
    expect(body.indexOf("mergeLockOf(")).toBeGreaterThan(body.indexOf("--disable-auto"));
    expect(body.indexOf("mergeLockOf(")).toBeLessThan(body.indexOf('const args = ["pr", "merge"'));
    expect(idx).toMatch(/case "\/prs\/merge": res = await mergePr\(/);
    expect(idx).toMatch(/mergeLockWrite\(pathname, b, mayPublishReview\(req, caller\)/);
    expect(idx).toMatch(/const lockedMerge = await gateMergeLock\(greq\.tool_name, ti, out, cwd\);\n\s*if \(lockedMerge\) return json\(denyByRule\(greq, lockedMerge\)\)/);
  });
});
