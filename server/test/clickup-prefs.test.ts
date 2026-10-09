/*
 * The ClickUp workflow settings: the file, the validation, and the route.
 *
 * What is asserted is that an empty settings file reproduces what the app did
 * before the settings existed, that nothing malformed reaches disk, and that
 * the route will not take a write from a page on another origin.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as P from "../src/clickupPrefs.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { story } from "./story.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-prefs-"));
const file = join(dir, "prefs.json");
// Removed once, after every describe: with --seed the describes run in any
// order, and the route's own cleanup used to delete this under the store's tests.
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the store", () => {
  beforeEach(() => { rmSync(file, { force: true }); P.__setPrefsPath(file); });
  afterAll(() => P.__setPrefsPath(null));

  test("a missing file is today's behaviour: every setting at its default", () => {
    expect(existsSync(file)).toBe(false);
    expect(P.clickupPrefs()).toEqual({
      handoff: { enabled: false, blocks: [], statusNames: [], unassign: "none", assign: { who: "none" } },
      review: { enabled: false, blocks: [], statusNames: [], assignReviewer: false, assign: { who: "none" } },
      merge: { enabled: false, blocks: [], statusNames: [], assign: { who: "none" } },
      flows: { noteOnCard: false },
      prLinkField: "",
      swatchField: "",
      cardSkillPattern: "clickup|\\bcu-|-cu\\b",
      assigned: { includeSubtasks: false },
      sprintListPattern: "^sprint\\b",
      readOnlyFieldPattern: "do not edit",
      bell: { kinds: ["assigned", "status", "mention", "comment"] },
      statusSpaces: { counted: [] },
    });
  });

  test("the chosen spaces are ids: saved as given, an old file without them reads as the default, junk is refused", () => {
    expect(P.applyPrefs(P.defaultPrefs(), { statusSpaces: { counted: ["901", "902", "901"] } })).toMatchObject({ ok: true, value: { statusSpaces: { counted: ["901", "902"] } } });
    expect(P.applyPrefs(P.defaultPrefs(), { statusSpaces: { counted: ["Sales"] } }).ok).toBe(false);
    expect(P.applyPrefs(P.defaultPrefs(), { statusSpaces: { counted: "901" } }).ok).toBe(false);
    expect(P.applyPrefs(P.defaultPrefs(), { statusSpaces: { all: true } }).ok).toBe(false);
    writeFileSync(file, JSON.stringify({ bell: { kinds: ["status"] } }));
    P.__setPrefsPath(file);
    expect(P.clickupPrefs().statusSpaces).toEqual({ counted: [] });
  });

  test("a partial update merges one level and survives a reload", () => {
    const r = P.setClickupPrefs({ handoff: { enabled: true, statusNames: ["Testing", " QA "] }, prLinkField: "PR link" });
    expect(r.ok).toBe(true);
    P.__setPrefsPath(file); // drops the cache: this reads the file
    const p = P.clickupPrefs();
    expect(p.handoff).toEqual({ enabled: true, blocks: [{ type: "move", statusNames: ["Testing", "QA"] }], statusNames: ["Testing", "QA"], unassign: "none", assign: { who: "none" } });
    expect(p.prLinkField).toBe("PR link");
    expect(p.bell.kinds).toHaveLength(4);
  });

  test("wrong types are refused with a sentence that names the setting, and nothing is written", () => {
    const cases: [unknown, RegExp][] = [
      [{ handoff: { enabled: "yes" } }, /handoff\.enabled must be true or false/],
      [{ handoff: { statusNames: "Testing" } }, /handoff\.statusNames must be a list/],
      [{ handoff: { unassign: "everyone" } }, /handoff\.unassign must be none, me or all/],
      [{ review: { assignReviewer: 1 } }, /review\.assignReviewer must be true or false/],
      [{ prLinkField: 7 }, /prLinkField must be text/],
      [{ bell: { kinds: ["status", "party"] } }, /bell\.kinds has an unknown kind/],
      [{ nonsense: true }, /nonsense is not a setting/],
      [{ handoff: { colour: "red" } }, /handoff\.colour is not a setting/],
      [{ flows: [] }, /flows must be an object/],
      ["handoff", /settings must be an object/],
      [{ handoff: { statusNames: Array.from({ length: 21 }, (_, i) => "s" + i) } }, /more than 20 entries/],
      [{ swatchField: "x".repeat(201) }, /longer than 200/],
    ];
    for (const [input, say] of cases) {
      const r = P.setClickupPrefs(input);
      expect(r.ok, JSON.stringify(input).slice(0, 60)).toBe(false);
      expect((r as { error: string }).error).toMatch(say);
    }
    expect(existsSync(file)).toBe(false);
  });

  test("a pattern that does not compile is refused; an empty one means the default", () => {
    for (const k of ["cardSkillPattern", "sprintListPattern", "readOnlyFieldPattern"]) {
      const r = P.setClickupPrefs({ [k]: "(unclosed" });
      expect(r.ok, k).toBe(false);
      expect((r as { error: string }).error).toContain(`${k} is not a valid pattern`);
    }
    expect(existsSync(file)).toBe(false);
    const ok = P.setClickupPrefs({ sprintListPattern: "^iteration \\d" });
    expect(ok.ok && ok.prefs.sprintListPattern).toBe("^iteration \\d");
    const back = P.setClickupPrefs({ sprintListPattern: "" });
    expect(back.ok && back.prefs.sprintListPattern).toBe("^sprint\\b");
  });

  test("one refused key stops the whole update", () => {
    P.setClickupPrefs({ prLinkField: "PR link" });
    const r = P.setClickupPrefs({ swatchField: "Colour", handoff: { unassign: "nobody" } });
    expect(r.ok).toBe(false);
    expect(P.clickupPrefs().swatchField).toBe("");
    expect(P.clickupPrefs().prLinkField).toBe("PR link");
  });

  test("a kind switched off is not told to the bell, the rest still are", async () => {
    const { wantedOnBell } = await import("../src/clickupwatch.ts");
    const note = (kind: "assigned" | "status" | "mention" | "comment") => ({ kind, id: "a", label: "ORBIT-1", title: "t", status: "open", url: "" });
    expect(wantedOnBell(note("status"))).toBe(true);
    P.setClickupPrefs({ bell: { kinds: ["assigned", "mention", "comment"] } });
    expect(wantedOnBell(note("status"))).toBe(false);
    expect(wantedOnBell(note("mention"))).toBe(true);
    // The timer is what emits, so the filter has to sit in front of `emit`.
    const watch = readFileSync(join(import.meta.dir, "../src/clickupwatch.ts"), "utf8");
    expect(watch).toMatch(/await pollCards\(\)\) if \(wantedOnBell\(n\)\) emit\(n\)/);
  });

  test("bell kinds keep their order and drop repeats", () => {
    const r = P.setClickupPrefs({ bell: { kinds: ["comment", "assigned", "comment"] } });
    expect(r.ok && r.prefs.bell.kinds).toEqual(["assigned", "comment"]);
    const none = P.setClickupPrefs({ bell: { kinds: [] } });
    expect(none.ok && none.prefs.bell.kinds).toEqual([]);
  });

  test("a hand-edited file keeps the keys that are still good", () => {
    writeFileSync(file, JSON.stringify({ handoff: { enabled: "maybe" }, prLinkField: "PR link", sprintListPattern: "(" }));
    P.__setPrefsPath(file);
    const p = P.clickupPrefs();
    expect(p.handoff.enabled).toBe(false);
    expect(p.prLinkField).toBe("PR link");
    expect(p.sprintListPattern).toBe("^sprint\\b");
  });

  test("a garbled file is the defaults, not an error", () => {
    writeFileSync(file, "{ not json");
    P.__setPrefsPath(file);
    expect(P.clickupPrefs()).toEqual(P.defaultPrefs());
  });

  test("the write leaves no temporary file behind", () => {
    P.setClickupPrefs({ flows: { noteOnCard: true } });
    expect(readdirSync(dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).flows.noteOnCard).toBe(true);
  });

  /*
   * The settings arrived after people were already using ClickUp. Their
   * reviewer list, Note on card and hand-off must not switch off with the
   * update; somebody who connects next week must not inherit them.
   */
  test("first start with a token: the three flows they had stay on, and the file is written", () => {
    expect(P.settleFirstRun(true)).toBe("seeded");
    const p = P.clickupPrefs();
    expect(p.review.assignReviewer).toBe(true);
    expect(p.flows.noteOnCard).toBe(true);
    expect(p.handoff).toEqual({ enabled: true, blocks: [{ type: "move", statusNames: [], fallback: true }, { type: "unassign", who: "all" }], statusNames: [], unassign: "all", assign: { who: "none" } });
    expect(p.sprintListPattern).toBe("^sprint\\b");
    expect(JSON.parse(readFileSync(file, "utf8")).flows.noteOnCard).toBe(true);
  });

  test("first start without one: defaults, and connecting later does not seed", () => {
    expect(P.settleFirstRun(false)).toBe("defaults");
    expect(P.clickupPrefs()).toEqual(P.defaultPrefs());
    // The next start, with a token now: the file is already there, so it is theirs.
    expect(P.settleFirstRun(true)).toBe("kept");
    expect(P.clickupPrefs().flows.noteOnCard).toBe(false);
  });

  test("the server settles it at start, before the card watch reads anything", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const settle = index.indexOf('settleFirstRun(hasCredential("clickup"))');
    expect(settle).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(index.indexOf("startCardWatch((n) =>"));
  });

  test("a saved file is never touched, even with a token", () => {
    P.setClickupPrefs({ flows: { noteOnCard: false }, review: { assignReviewer: false } });
    expect(P.settleFirstRun(true)).toBe("kept");
    expect(P.clickupPrefs().review.assignReviewer).toBe(false);
  });

  /*
   * A pattern the server tests against names anyone in the workspace can type.
   * `^(a|a)+$` against "a" x 24 + "b" took 143 ms and doubled per character,
   * on the one thread the whole app runs on. It compiled, so it was saved.
   */
  test("a pattern that backtracks without limit is refused at save", () => {
    for (const bad of ["^(a|a)+$", "(x+)+y", "^(\\w+\\s?)*$", "(a)\\1", "(?:a|aa)*b"]) {
      const r = P.applyPrefs(P.defaultPrefs(), { sprintListPattern: bad });
      expect(r.ok, bad).toBe(false);
      expect((r as { error: string }).error).toContain("can hang the app");
    }
  });

  /*
   * Polynomial, not exponential, and still a freeze: five adjacent overlapping
   * quantifiers against 200 `a`s took 90.8 s. The degree is the count of them.
   */
  test("a pattern with more than two unbounded repeats is refused at save", () => {
    for (const bad of ["a*a*a*a*a*c", "a+a+a+c", "x.*y.*z.*w", "a{2,}b{1,}c*d", "a{0,999}a{0,999}a{0,999}c"]) {
      const r = P.applyPrefs(P.defaultPrefs(), { readOnlyFieldPattern: bad });
      expect(r.ok, bad).toBe(false);
      expect((r as { error: string }).error).toContain("can hang the app");
    }
    // A star that is a character is not a repeat.
    expect(P.patternProblem("\\*\\*\\*[*+]*x")).toBeNull();
  });

  test("the worst pattern that still saves answers a long hostile name at once", () => {
    expect(P.patternProblem("a*a*c")).toBeNull();
    const t = performance.now();
    expect(P.matchPref("a*a*c", "^sprint\\b", "a".repeat(5000))).toBe(false);
    expect(performance.now() - t).toBeLessThan(50);
  });

  test("the patterns people actually write still save", () => {
    for (const ok of ["^sprint\\b", "^(sprint|iteration) \\d+", "clickup|\\bcu-|-cu\\b", "do not edit", "(q[1-4])\\s*plan"]) {
      expect(P.applyPrefs(P.defaultPrefs(), { readOnlyFieldPattern: ok }).ok, ok).toBe(true);
    }
  });

  test("a hand-edited unsafe pattern falls back to the default and answers at once", () => {
    writeFileSync(file, JSON.stringify({ sprintListPattern: "^(a|a)+$" }));
    P.__setPrefsPath(file);
    const src = P.clickupPrefs().sprintListPattern;
    const t = performance.now();
    const hit = P.matchPref(src, "^sprint\\b", "a".repeat(40) + "b");
    expect(hit).toBe(false);
    expect(performance.now() - t).toBeLessThan(50);
  });

  test("a name is cut to 64 characters before a pattern sees it", () => {
    // Bounded, so a slow pattern the heuristic cannot see still costs 64 characters at most.
    expect(P.matchPref("^x.*y$", "^sprint\\b", "x" + "z".repeat(62) + "y")).toBe(true);
    expect(P.matchPref("^x.*y$", "^sprint\\b", "x" + "z".repeat(63) + "y")).toBe(false);
    expect(P.matchPref("^x.*z$", "^sprint\\b", "x" + "z".repeat(500))).toBe(true);
  });
});

describe("the route", () => {
  // One server, read and written in order: the first GET is the never-saved one.
  const step = story();
  let proc: ReturnType<typeof Bun.spawn> | null = null, base = "";
  const cfg = join(dir, "srv");

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
        TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        HOME: dir,
        XDG_CONFIG_HOME: cfg,
        XDG_DATA_HOME: join(dir, "data"),
        XDG_CACHE_HOME: join(dir, "cache"),
        AGENTGLASS_STATE_DIR: join(dir, "state"),
        AGENTGLASS_ROOT: dir,
        AGENTGLASS_DB: join(dir, "f.db"),
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
  }, SERVER_BOOT_MS);

  afterAll(() => {
    try { proc?.kill(); } catch { /* already gone */ }
    rmSync(cfg, { recursive: true, force: true });
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/clickup/prefs", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  step("GET answers the defaults when nothing was ever saved", async () => {
    const j = await (await fetch(base + "/clickup/prefs")).json() as any;
    expect(j.ok).toBe(true);
    expect(j.prefs.handoff.enabled).toBe(false);
    expect(j.prefs.bell.kinds).toHaveLength(4);
  });

  step("POST saves, GET reads it back, and the file lands under XDG_CONFIG_HOME", async () => {
    const r = await post({ handoff: { enabled: true, statusNames: ["Testing"] } });
    expect(r.status).toBe(200);
    const j = await (await fetch(base + "/clickup/prefs")).json() as any;
    expect(j.prefs.handoff).toEqual({ enabled: true, blocks: [{ type: "move", statusNames: ["Testing"] }], statusNames: ["Testing"], unassign: "none", assign: { who: "none" } });
    const onDisk = JSON.parse(readFileSync(join(cfg, "agentglass", "clickup-prefs.json"), "utf8"));
    expect(onDisk.handoff.enabled).toBe(true);
  });

  step("a refusal is a 400 with a sentence", async () => {
    const r = await post({ handoff: { unassign: "everyone" } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/handoff\.unassign/);
    expect(await post("not an object")).toHaveProperty("status", 400);
  });

  /* On loopback a request with no Origin is a non-browser caller and is let in
     (hooks, curl), so the refusal that can be asserted from here is a foreign
     Origin. It is turned away by the gate every route sits behind; the route
     repeats the check with trustedCaller, as every other ClickUp write does,
     for the day it is reached by a path that skips the gate. */
  step("a write from a page on another origin is blocked and changes nothing", async () => {
    const r = await post({ prLinkField: "Hijacked" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const j = await (await fetch(base + "/clickup/prefs")).json() as any;
    expect(j.prefs.prLinkField).toBe("");
  });
});
