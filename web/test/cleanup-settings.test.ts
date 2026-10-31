// "After a PR is merged": the choices and the decisions behind the Settings section.
import { describe, expect, test } from "bun:test";
import {
  BRIEFS_HELP, CLEANUP_KIND_ROWS, addPattern, briefsOf, bulkLine, checkBriefsDir, withBriefsDir, cleanupModes, daysOf, daysState, filterProjects, includeOf, isCustom, modeOf, nowLine, projectName, repoSlug, retryPlan, runPlan,
  readPick, saveLine, showList, showSearch, stillThere, tickState, toggleRoot, toggleShown, valuesOf, withKind, writePick, writePlan, MODE_BADGE,
  type ProjectValues, type Writer,
} from "../src/lib/cleanupSettings.ts";

const SRC = await Bun.file(new URL("../src/components/CleanupSettings.tsx", import.meta.url).pathname).text();
const code = (t: string): string => t.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

describe("modes", () => {
  test("four modes in the mockup's order, Ask is the default", () => {
    expect(cleanupModes().map((m) => m.id)).toEqual(["off", "ask", "atMerge", "auto"]);
    expect(cleanupModes().filter((m) => m.isDefault).map((m) => m.id)).toEqual(["ask"]);
  });
  test("without a merge action in the PR view the offer-at-merge mode is not drawn, not drawn dead", () => {
    expect(cleanupModes(false).map((m) => m.id)).toEqual(["off", "ask", "auto"]);
    expect(modeOf("atMerge", false)).toBe("ask");
    expect(modeOf("atMerge", true)).toBe("atMerge");
  });
  test("a value this build does not know reads as the default", () => {
    expect(modeOf("sometimes")).toBe("ask");
    expect(modeOf(undefined)).toBe("ask");
    expect(modeOf("auto")).toBe("auto");
  });
  test("every mode has a sentence for the NOW line", () => {
    for (const m of cleanupModes()) expect(nowLine(m.id)).toStartWith(m.title);
  });
});

describe("what to include", () => {
  test("the nine kinds the server knows, ids equal to the server's", () => {
    expect(CLEANUP_KIND_ROWS.map((k) => k.id)).toEqual(["docker", "worktree", "branch", "stashes", "evidence", "notes", "tab", "agent-scratch", "agent-history"]);
  });
  test("unticking keeps the canonical order; unknown words are dropped; nothing stored is everything", () => {
    expect(withKind(includeOf(null), "branch", false)).toEqual(["docker", "worktree", "stashes", "evidence", "notes", "tab", "agent-scratch"]);
    expect(withKind(["tab", "docker"], "worktree", true)).toEqual(["docker", "worktree", "tab"]);
    expect(includeOf(["tab", "nope", "docker"])).toEqual(["docker", "tab"]);
    expect(includeOf(null)).toHaveLength(8); // everything but the session history, like a new project on the server
    expect(includeOf(null)).not.toContain("agent-history");
    expect(includeOf([])).toEqual([]);
  });
});

describe("older than N days", () => {
  test("whole days from 1 to 365 only", () => {
    expect(daysOf("14")).toBe(14);
    for (const bad of ["", "0", "-3", "1.5", "366", "abc", "1e2"]) expect(daysOf(bad)).toBeNull();
  });
  test("stored 0 is off and shows the default; a stored number is on", () => {
    expect(daysState(0)).toEqual({ on: false, shown: "14" });
    expect(daysState(30)).toEqual({ on: true, shown: "30" });
    expect(daysState(undefined)).toEqual({ on: false, shown: "14" });
  });
});

describe("what a write says", () => {
  test("applied, waiting for the person, refused, no answer", () => {
    expect(saveLine({ ok: true, applied: true }).phase).toBe("saved");
    expect(saveLine({ ok: true, applied: false }).phase).toBe("waits");
    expect(saveLine({ ok: false, error: "no" })).toEqual({ phase: "error", text: "no" });
    expect(saveLine(null).phase).toBe("error");
  });
  test("a project is named by its folder", () => { expect(projectName("/home/dev/code/orbit")).toBe("orbit"); });
});

describe("the project's name in the list", () => {
  test("owner/repo from a GitHub remote, upstream before origin as the PR view reads it, in both URL forms", () => {
    expect(repoSlug([{ name: "origin", fetchUrl: "https://github.com/acme/orbit.git" }])).toBe("acme/orbit");
    expect(repoSlug([{ name: "origin", fetchUrl: "git@github.com:acme/orbit.git" }])).toBe("acme/orbit");
    expect(repoSlug([{ name: "origin", fetchUrl: "https://github.com/me/orbit" }, { name: "upstream", fetchUrl: "ssh://git@github.com/acme/orbit.git" }])).toBe("acme/orbit");
  });
  test("a remote that is not GitHub, or none, is null so the folder name shows", () => {
    expect(repoSlug([])).toBeNull();
    expect(repoSlug([{ name: "origin", fetchUrl: "https://gitlab.com/acme/orbit.git" }])).toBeNull();
    expect(repoSlug([{ name: "origin", fetchUrl: "https://github.com.evil.example/acme/orbit" }])).toBeNull();
  });
  test("the section reads it from the project's remotes, falling back to the folder", () => {
    expect(SRC).toContain("api.gitRemotes(");
    expect(SRC).toContain("slugs[p] ?? projectName(p)");
  });
});

// Ten invented projects, the shape of a real machine.
const POOL = ["/w/acme/orbit", "/w/orbit-api", "/w/orbit-web", "/w/orbit-mobile", "/w/orbit-infra", "/w/acme-docs", "/w/acme-site", "/w/acme-billing", "/w/acme-sdk", "/w/acme-design"];
const nameOf = (r: string): string => projectName(r);
describe("Save to several projects", () => {
  const draft = valuesOf("auto", 21, ["docker", "branch"]);
  const roots = ["/w/orbit-api", "/w/orbit-web", "/w/acme-docs"];
  const ok = { ok: true, applied: true };
  /** A writer that records every call and refuses the roots it is told to. */
  const recorder = (refuse: Record<string, string> = {}) => {
    const calls: { root: string; id: string; value: unknown }[] = [];
    const write: Writer = async (root, id, value) => { calls.push({ root, id, value }); return refuse[root] ? { ok: false, error: refuse[root] } : ok; };
    return { calls, write };
  };

  test("every ticked root is written once per setting with the same values; a root not ticked is never written", async () => {
    const { calls, write } = recorder();
    const results = await runPlan(writePlan(roots, draft), write);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(calls.map((c) => c.root))).toEqual(new Set(roots));
    for (const r of roots) {
      expect(calls.filter((c) => c.root === r).map((c) => [c.id, c.value])).toEqual([["cleanup.mode", "auto"], ["cleanup.autoCleanDays", 21], ["cleanup.include", ["docker", "branch"]]]);
    }
    expect(calls).toHaveLength(9);
    expect(calls.some((c) => !roots.includes(c.root))).toBe(false);
  });

  test("one refused root is named with its reason, the others still saved, and Retry writes only that one", async () => {
    const plan = writePlan(roots, draft);
    const first = recorder({ "/w/orbit-web": "its settings file is read-only" });
    const results = await runPlan(plan, first.write);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(first.calls.filter((c) => c.root === "/w/orbit-web")).toHaveLength(1); // stops at its first refusal
    expect(results[1]).toEqual({ root: "/w/orbit-web", ok: false, reason: "its settings file is read-only" });
    expect(bulkLine(results)).toEqual({ saved: 2, failed: 1, text: "2 of 3 saved" });
    const again = recorder();
    const retried = await runPlan(retryPlan(plan, results), again.write);
    expect(new Set(again.calls.map((c) => c.root))).toEqual(new Set(["/w/orbit-web"]));
    expect(retried.every((r) => r.ok)).toBe(true);
  });

  test("a writer that throws or does not answer is a refusal, not a crash", async () => {
    const results = await runPlan(writePlan(["/w/orbit-api", "/w/orbit-web"], draft), async (root) => { if (root === "/w/orbit-web") throw new Error("boom"); return null; });
    expect(results).toEqual([{ root: "/w/orbit-api", ok: false, reason: "The server did not answer." }, { root: "/w/orbit-web", ok: false, reason: "The server did not answer." }]);
  });

  test("the bulk line counts what went in and what did not", () => {
    expect(bulkLine([{ root: "a", ok: true }, { root: "b", ok: true }])).toEqual({ saved: 2, failed: 0, text: "2 saved" });
    expect(bulkLine([{ root: "a", ok: false, reason: "no" }])).toMatchObject({ saved: 0, failed: 1, text: "0 of 1 saved" });
  });

  test("a bulk write sends all three settings, in the section's order", () => {
    expect(writePlan(["/w/orbit-api"], valuesOf("ask", 0, null))[0]!.writes.map((w) => w.id)).toEqual(["cleanup.mode", "cleanup.autoCleanDays", "cleanup.include"]);
  });
});

describe("which rows are ticked", () => {
  test("one project is the page alone, two or more get the list", () => {
    expect([0, 1, 2, 20].map(showList)).toEqual([false, false, true, true]);
  });
  test("a tick adds and removes", () => {
    expect(toggleRoot(toggleRoot([], "/w/orbit-web"), "/w/acme-docs")).toEqual(["/w/orbit-web", "/w/acme-docs"]);
    expect(toggleRoot(["/w/orbit-web"], "/w/orbit-web")).toEqual([]);
  });
  test("the header checkbox is empty, half, or full over the rows shown", () => {
    expect(tickState([], POOL)).toBe("none");
    expect(tickState(["/w/orbit-api"], POOL)).toBe("some");
    expect(tickState(POOL, POOL)).toBe("all");
    expect(tickState(["/w/orbit-api"], ["/w/orbit-api"])).toBe("all");
  });
  test("the header ticks every row shown, or clears them; a row hidden by the search keeps its tick", () => {
    expect(toggleShown(["/w/orbit-api"], POOL)).toHaveLength(10);
    expect(toggleShown(POOL, POOL)).toEqual([]);
    const shown = filterProjects(POOL, "orbit", nameOf);
    expect(toggleShown(["/w/acme-docs", ...shown], shown)).toEqual(["/w/acme-docs"]);
  });
  test("a tick on a project that is gone is dropped", () => {
    expect(stillThere(["/w/orbit-api", "/w/gone"], POOL)).toEqual(["/w/orbit-api"]);
  });
  test("the search box is there from the ninth project, not before", () => {
    expect(showSearch(8)).toBe(false);
    expect(showSearch(9)).toBe(true);
    expect(filterProjects(POOL, " WEB ", nameOf)).toEqual(["/w/orbit-web"]);
    expect(filterProjects(POOL, "zz", nameOf)).toEqual([]);
    expect(filterProjects(POOL, "", nameOf)).toHaveLength(10);
  });
  test("a row is custom when the days or the kinds differ from a new project's", () => {
    expect(isCustom(valuesOf("ask", 0, null))).toBe(false);
    expect(isCustom(valuesOf("ask", 14, null))).toBe(true);
    expect(isCustom(valuesOf("auto", 0, ["docker"]))).toBe(true);
    expect(isCustom(valuesOf("off", 0, null))).toBe(false); // the mode has its own badge
  });
  test("every mode has a short badge", () => {
    expect(cleanupModes().map((m) => MODE_BADGE[m.id])).toEqual(["Off", "Ask", "Offer at merge", "Auto"]);
  });
});

describe("the clicked project is remembered", () => {
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
  test("what was clicked comes back; a project that is gone, or nothing stored, falls back to the first", () => {
    const st = store();
    expect(readPick(POOL, st)).toBe(POOL[0]!);
    writePick("/w/orbit-web", st);
    expect(readPick(POOL, st)).toBe("/w/orbit-web");
    expect(readPick(["/w/acme-docs", "/w/acme-sdk"], st)).toBe("/w/acme-docs");
    expect(readPick([], st)).toBe("");
  });
  test("a storage that throws is not a crash", () => {
    const boom = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readPick(POOL, boom)).toBe(POOL[0]!);
    expect(() => writePick("/w/orbit-web", boom)).not.toThrow();
  });
});

describe("the page is wired to those decisions", () => {
  const c = code(SRC);
  test("one project is the page alone; two or more add the list", () => {
    expect(c).toContain("const list = showList(pool.length)");
    expect(c).toContain("if (!list) return page;");
  });
  test("a click on a row edits just that project and remembers it; ticks are a separate set", () => {
    expect(c).toMatch(/const click = \(r: string\) => \{ setPick\(r\); writePick\(r\); \}/);
    expect(c).toContain("onClick={() => click(r)}");
    expect(c).toContain("onChange={() => setTicks(toggleRoot(now, r))}");
    expect(c).not.toMatch(/writePick\([^)]*now/);
  });
  test("with no ticks every control writes at once; with ticks it only changes the draft", () => {
    for (const fn of ["pickMode", "flipDays", "tick"]) {
      const at = c.indexOf(`const ${fn} = `);
      const body = c.slice(at, c.indexOf("\n  };", at));
      expect(body).toMatch(/if \(drafting\) return;[\s\S]*await write\(/);
    }
    expect(c).toMatch(/const commitDays = [\s\S]*?if \(!drafting\) await write\(/);
    expect(c).toContain("api.settingAtSet(id, value, root)");
  });
  test("Apply is N ordinary writes through the plan, and Retry reruns only the plans that failed", () => {
    expect(c).toMatch(/const apply = [\s\S]*?run\(writePlan\(now, \{ mode, days: draftDays, include \}\)\)/);
    expect(c).toContain("retry: plan.find((p) => p.root === r.root)!");
    expect(c).toMatch(/const retryAll = [\s\S]*?run\(failedPlans\)/);
    expect(c).toMatch(/const retryRow = [\s\S]*?run\(\[s\.retry\]\)/);
  });
  test("a refused row stays red with a Retry of its own; Apply waits on a bad number of days", () => {
    expect(c).toContain("data-bad={s?.phase === \"error\" ? \"\" : undefined}");
    expect(c).toMatch(/<Button size="compact" tone="danger"[^>]*onClick=\{\(\) => retryRow\(r\)\}/);
    expect(c).toContain("disabled={busy || draftDays === null}");
  });
  test("the bar shows only while rows are ticked, and the search only from nine projects", () => {
    expect(c).toContain("{drafting && (");
    expect(c).toContain("showSearch(pool.length)");
    expect(c).toContain("Apply the values below to {now.length}");
    expect(c).toContain("Draft for ${now.length} project${now.length === 1 ? \"\" : \"s\"}");
  });
  test("the header checkbox can be half-ticked", () => {
    expect(c).toContain('head.current.indeterminate = state === "some"');
  });
  test("the Applies to popover, its Only button and the table are gone", async () => {
    for (const f of ["CleanupAppliesTo.tsx", "CleanupTable.tsx"]) expect(await Bun.file(new URL(`../src/components/${f}`, import.meta.url).pathname).exists()).toBe(false);
    expect(c).not.toMatch(/Applies to|readSelection|writeSelection|agx-cl-only|agx-cl-tbl/);
  });
});

describe("the days switch is a button of its own", () => {
  const fn = SRC.slice(SRC.indexOf("function DaysField("), SRC.indexOf("\n}\n", SRC.indexOf("function DaysField(")));
  test("only the number box keeps its clicks from the row, so a click on the switch reaches the row's toggle", () => {
    const code = fn.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code.match(/stopPropagation/g)?.length).toBe(1);
    expect(code).not.toMatch(/agx-cl-age"[^>]*onClick/);
  });
});

describe("the briefs folder", () => {
  test("it is read from the stored cleanup object and written back with every other field kept", () => {
    expect(briefsOf({ briefsDir: "~/orbit-notes/briefs", worklogDir: "x" })).toBe("~/orbit-notes/briefs");
    expect(briefsOf(null)).toBe("");
    expect(briefsOf({ briefsDir: 5 })).toBe("");
    const body = { briefsDir: "", worklogDir: "~/orbit-notes/worklog", transientMarkers: ["-ci-"] };
    expect(withBriefsDir(body, "~/orbit-notes/briefs")).toEqual({ ...body, briefsDir: "~/orbit-notes/briefs" });
    expect(withBriefsDir(undefined, "~/orbit-notes/briefs")).toEqual({ briefsDir: "~/orbit-notes/briefs" });
  });
  test("empty turns it off, a full path is kept, a relative or broad one says why", () => {
    expect(checkBriefsDir("  ")).toEqual({ ok: true, dir: "" });
    expect(checkBriefsDir("~/orbit-notes/briefs/")).toEqual({ ok: true, dir: "~/orbit-notes/briefs" });
    expect(checkBriefsDir("briefs").ok).toBe(false);
    expect(checkBriefsDir("~/a/../b").ok).toBe(false);
    expect(checkBriefsDir("/tmp").ok).toBe(false);
  });
  test("the explanation says moved, archive and never deleted, and that it is not the evidence folder", () => {
    expect(BRIEFS_HELP).toMatch(/moved/);
    expect(BRIEFS_HELP).toMatch(/archive\//);
    expect(BRIEFS_HELP).toMatch(/never deleted/);
    expect(BRIEFS_HELP).toMatch(/Not an evidence folder/);
  });
  test("the field sits next to Evidence folders, saves through cleanup.config, and shows only while Notes is ticked", () => {
    const c = code(SRC);
    expect(c).toContain('aria-label="Briefs folder"');
    expect(c.indexOf('aria-label="Evidence folders"')).toBeLessThan(c.indexOf('aria-label="Briefs folder"'));
    expect(c).toMatch(/include\.includes\("notes"\)[^]*aria-label="Briefs folder"/);
    const i = c.indexOf("const saveBriefs = async () => {"), fn = c.slice(i, c.indexOf("\n  };", i));
    expect(fn).toContain('api.settingAt("cleanup.config", root)');
    expect(fn).toContain('write("cleanup.config", withBriefsDir(cur.value');
  });
});

describe("other folders", () => {
  test("a pattern needs a written-out parent two deep and {card} or {number} in the last name", () => {
    expect(addPattern([], "~/code/orbit-pol-master-{number}*")).toEqual({ ok: true, list: ["~/code/orbit-pol-master-{number}*"] });
    expect(addPattern(["~/code/x-{card}"], "~/code/x-{card}").ok).toBe(false);
    for (const bad of ["", "code/x-{number}", "~/code/../x-{number}", "~/x-{number}", "~/co*/x-{number}", "~/code/fixed", "~/code/x-{slug}-{number}"]) expect(addPattern([], bad).ok).toBe(false);
  });
  test("the field is saved as cleanup.otherFolders and shows while Worktree is ticked", () => {
    const c = code(SRC);
    expect(c).toContain('write("cleanup.otherFolders", next)');
    expect(c).toMatch(/include\.includes\("worktree"\)[^]*aria-label="Other folders"/);
  });
});
