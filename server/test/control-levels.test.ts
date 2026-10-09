/*
 * The level model of /control, without a server: which entry runs at which
 * level, what a refusal says, how the two switches combine, and that nothing an
 * agent can reach is able to move them. The same switch against a process is
 * control-levels-live.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { controlRefusal, controlSwitch, makeRefusalThrottle, parseControlCmd, UI_MAX_LEVEL } from "../src/control.ts";
import {
  KINDS_AT_LEVEL, UI_ACTIONS, describeUiActions, entryOfBody, isWriteKind, levelAllows, levelRefusal, parseUi,
  type UiActionDef, type UiKind, type UiLevel,
} from "../../shared/uiActions.ts";

const KINDS: UiKind[] = ["open", "read", "change", "stage"];
const LEVELS: UiLevel[] = [1, 2, 3];

/** The one rule, written out a second time on purpose: a kind belongs to exactly one level. */
const LEVEL_OF_KIND: Record<UiKind, UiLevel> = { open: 1, read: 1, change: 2, stage: 3 };

describe("level x kind: what a server at each level runs", () => {
  // Every pair, including the ones the types forbid: a cast, a plugin or a typo can build them.
  for (const server of LEVELS) for (const level of LEVELS) for (const kind of KINDS) {
    const expected = level <= server && LEVEL_OF_KIND[kind] === level;
    test(`server level ${server}, entry level ${level} kind ${kind}: ${expected ? "runs" : "refused"}`, () => {
      const registry = { x: { level, kind, surface: "x", args: {} } } as unknown as Record<string, UiActionDef>;
      expect(levelAllows(registry.x!, server)).toBe(expected);
      expect(parseUi(registry, "x", {}, server) !== null).toBe(expected);
    });
  }

  test("an entry with no level, or a level that is not 1, 2 or 3, is level 3: never 'unlimited'", () => {
    for (const lv of [undefined, null, 0, 4, "2", NaN, -1]) {
      for (const kind of KINDS) {
        // At level 3 a stage with a junk level is still a stage at level 3, and that is the only way through.
        expect(levelAllows({ level: lv, kind }, 2), `${String(lv)}/${kind} at 2`).toBe(false);
        expect(levelAllows({ level: lv, kind }, 3), `${String(lv)}/${kind} at 3`).toBe(kind === "stage");
      }
    }
  });

  test("a kind this build has never heard of runs at no level, including the old 'external'", () => {
    for (const kind of ["external", "merge", "", undefined, null, 3]) {
      for (const level of LEVELS) for (const server of LEVELS) expect(levelAllows({ level, kind }, server), `${String(kind)} ${level}/${server}`).toBe(false);
    }
  });

  test("KINDS_AT_LEVEL is a partition: every kind sits at exactly one level", () => {
    for (const k of KINDS) expect(LEVELS.filter((l) => KINDS_AT_LEVEL[l].includes(k)), k).toEqual([LEVEL_OF_KIND[k]]);
  });

  test("only change and stage count as writes", () => {
    expect(KINDS.filter(isWriteKind)).toEqual(["change", "stage"]);
    expect(isWriteKind(undefined)).toBe(false);
  });
});

describe("the real registry at each level", () => {
  const ids = (level: UiLevel) => Object.keys(UI_ACTIONS).filter((id) => levelAllows(UI_ACTIONS[id as keyof typeof UI_ACTIONS], level));

  test("level 1 holds every open and read and no change", () => {
    const want = Object.entries(UI_ACTIONS).filter(([, d]) => d.kind === "open" || d.kind === "read").map(([id]) => id);
    expect(ids(1).sort()).toEqual(want.sort());
    expect(ids(1)).not.toContain("settings.set");
  });

  test("level 2 adds the settings write, the palette and the zoom, which persist; level 3 adds exactly the stage entries", () => {
    expect(ids(2).filter((i) => !ids(1).includes(i)).sort()).toEqual(["settings.set", "theme.set", "zoom.step"]);
    expect(ids(3).filter((i) => !ids(2).includes(i))).toEqual((Object.entries(UI_ACTIONS) as [string, UiActionDef][]).filter(([, d]) => d.level === 3).map(([i]) => i));
    for (const [id, d] of Object.entries(UI_ACTIONS) as [string, UiActionDef][]) if (d.level === 3) expect(d.kind, id).toBe("stage");
  });

  test("every entry is classified: a level in 1..3 and the kind that level admits", () => {
    for (const [id, d] of Object.entries(UI_ACTIONS)) {
      expect(LEVELS, id).toContain(d.level);
      expect(KINDS_AT_LEVEL[d.level], id).toContain(d.kind);
    }
  });

  test("the list served at a level is cut at it", () => {
    expect(describeUiActions(UI_ACTIONS, 1).map((a) => a.id)).not.toContain("settings.set");
    expect(describeUiActions(UI_ACTIONS, 2).map((a) => a.id)).toContain("settings.set");
    expect(UI_MAX_LEVEL).toBe(3);
  });

  test("a stage entry is accepted only from level 3 up, through parseControlCmd as well", () => {
    // A real body for a fake entry cannot be built through the real registry (it has none), so the
    // registry is a parameter: the same function the route calls.
    const reg = { "dialog.prepare": { level: 3, kind: "stage", surface: "x", args: {} } } as unknown as Record<string, UiActionDef>;
    expect(parseUi(reg, "dialog.prepare", {}, 2)).toBeNull();
    expect(parseUi(reg, "dialog.prepare", {}, 3)).not.toBeNull();
    // The real registry has no such id, so the real parser refuses it at every level.
    for (const l of LEVELS) expect(parseControlCmd({ cmd: "ui", do: "dialog.prepare", args: {} }, l)).toBeNull();
  });

  test("pr.unstick, the first real stage entry: level 3 only, a number and a path, nothing else", () => {
    const body = { cmd: "ui", do: "pr.unstick", args: { root: "/home/dev/orbit", number: 1042 } };
    expect(UI_ACTIONS["pr.unstick"].level).toBe(3);
    expect(UI_ACTIONS["pr.unstick"].kind).toBe("stage");
    for (const l of [1, 2] as UiLevel[]) {
      expect(parseControlCmd(body, l), `level ${l}`).toBeNull();
      expect(ids(l)).not.toContain("pr.unstick");
    }
    expect(parseControlCmd(body, 3)).not.toBeNull();
    expect(ids(3)).toContain("pr.unstick");
    // No argument smuggles a verb in: an unknown one is dropped, and a negative number, a relative path,
    // text where a number goes and a missing one are refused.
    expect(parseControlCmd({ cmd: "ui", do: "pr.unstick", args: { ...body.args, run: true } }, 3)).toEqual(body as never);
    for (const args of [
      { root: "/home/dev/orbit", number: -1 },
      { root: "orbit", number: 1 }, { root: "/home/dev/orbit", number: "1042; close" }, { root: "/home/dev/orbit" },
    ]) expect(parseControlCmd({ cmd: "ui", do: "pr.unstick", args }, 3), JSON.stringify(args)).toBeNull();
  });

  test("the old spellings obey the level too: a view is a look, a palette and a zoom persist and are level 2", () => {
    expect(parseControlCmd({ cmd: "view", to: "git" }, 1)).not.toBeNull();
    for (const old of [{ cmd: "theme", dir: 1 }, { cmd: "theme", name: "nord" }, { cmd: "zoom", dir: 1 }]) {
      expect(parseControlCmd(old, 1), JSON.stringify(old)).toBeNull();
      expect(parseControlCmd(old, 2), JSON.stringify(old)).not.toBeNull();
      expect(controlRefusal(old, controlSwitch({ AGENTGLASS_CONTROL_READONLY: "1" }))?.id, JSON.stringify(old)).toMatch(/^(theme\.set|zoom\.step)$/);
    }
  });

  test("every door that writes is counted by the write limit: theme and zoom included", () => {
    for (const id of ["settings.set", "theme.set", "zoom.step"]) expect(isWriteKind(UI_ACTIONS[id as keyof typeof UI_ACTIONS].kind), id).toBe(true);
  });

  test("the list served is cut on level AND kind: a door the parser would refuse is not listed", () => {
    const reg = {
      ok: { level: 1, kind: "open", surface: "x", args: {} },
      lie1: { level: 1, kind: "change", surface: "x", args: {} },
      lie3: { level: 3, kind: "change", surface: "x", args: {} },
      stage: { level: 3, kind: "stage", surface: "x", args: {} },
    } as unknown as Record<string, UiActionDef>;
    expect(describeUiActions(reg, 3).map((a) => a.id)).toEqual(["ok", "stage"]);
    expect(describeUiActions(reg, 2).map((a) => a.id)).toEqual(["ok"]);
    for (const l of LEVELS) for (const a of describeUiActions(reg, l)) expect(parseUi(reg, a.id, {}, l), a.id).not.toBeNull();
  });
});

describe("the two switches", () => {
  test("unset is 2; 1, 2 and 3 are taken as written", () => {
    expect(controlSwitch({}).level).toBe(2);
    expect(controlSwitch({ AGENTGLASS_CONTROL_LEVEL: "1" }).level).toBe(1);
    expect(controlSwitch({ AGENTGLASS_CONTROL_LEVEL: " 3 " }).level).toBe(3);
    expect(controlSwitch({ AGENTGLASS_CONTROL_LEVEL: "3" }).warnings).toEqual([]);
  });

  test("set to anything else, empty included, it fails CLOSED to 1 and warns once, naming the value", () => {
    for (const v of ["0", "off", "none", "readonly", "4", "x", "", "true", "2 3", "two"]) {
      const sw = controlSwitch({ AGENTGLASS_CONTROL_LEVEL: v });
      expect(sw.level, v).toBe(1);
      expect(sw.warnings.length, v).toBe(1);
      expect(sw.warnings[0], v).toContain(JSON.stringify(v));
      expect(sw.warnings[0], v).toContain("level 1");
    }
  });

  test("a warning quotes a bounded, control-free value", () => {
    const w = controlSwitch({ AGENTGLASS_CONTROL_LEVEL: "a\nb" + "z".repeat(500) }).warnings[0]!;
    expect(w).not.toContain("\n");
    expect(w.length).toBeLessThan(220);
  });

  test("READONLY: 1/true/yes/on is level 1 and beats any LEVEL; 0/false/no/off is nothing; other words fail closed with a warning", () => {
    expect(controlSwitch({ AGENTGLASS_CONTROL_READONLY: "1" })).toEqual({ level: 1, readonly: true, warnings: [] });
    expect(controlSwitch({ AGENTGLASS_CONTROL_READONLY: "1", AGENTGLASS_CONTROL_LEVEL: "3" })).toEqual({ level: 1, readonly: true, warnings: [] });
    for (const v of ["true", "YES", "on"]) expect(controlSwitch({ AGENTGLASS_CONTROL_READONLY: v }).readonly, v).toBe(true);
    for (const v of ["0", "false", "no", "off"]) expect(controlSwitch({ AGENTGLASS_CONTROL_READONLY: v }), v).toEqual({ level: 2, readonly: false, warnings: [] });
    for (const v of ["", "maybe", "readonly"]) {
      const sw = controlSwitch({ AGENTGLASS_CONTROL_READONLY: v });
      expect([sw.level, sw.readonly, sw.warnings.length], v).toEqual([1, true, 1]);
    }
  });

  test("the answer cannot be edited by whoever holds it", () => {
    const sw = controlSwitch({});
    expect(Object.isFrozen(sw)).toBe(true);
    expect(() => { (sw as { level: number }).level = 3; }).toThrow();
  });
});

describe("what a refusal says", () => {
  const body = { cmd: "ui", do: "settings.set", args: { id: "diff.wrap", value: true } };
  const OWNERS = "That limit is the owner's setting, made when the server starts; ask the person who runs agentglass if you need it, and do not try to change it.";

  test("a level 2 door at level 1 names itself, its level and whose decision the limit is", () => {
    const r = controlRefusal(body, controlSwitch({ AGENTGLASS_CONTROL_LEVEL: "1" }))!;
    expect(r.id).toBe("settings.set");
    expect(r.error).toBe(`settings.set is a level 2 door (it changes a local setting), and this server allows up to level 1. ${OWNERS}`);
  });

  test("under READONLY it says read-only", () => {
    const r = controlRefusal(body, controlSwitch({ AGENTGLASS_CONTROL_READONLY: "1", AGENTGLASS_CONTROL_LEVEL: "3" }))!;
    expect(r.error).toBe(`settings.set is a level 2 door (it changes a local setting), and the owner has made this server read-only (opens and reads only). ${OWNERS}`);
  });

  test("no refusal tells the agent how to raise its level: no variable, no value to set, no 'unset'", () => {
    const sentences = [
      controlRefusal(body, controlSwitch({ AGENTGLASS_CONTROL_LEVEL: "1" }))!.error,
      controlRefusal(body, controlSwitch({ AGENTGLASS_CONTROL_READONLY: "1" }))!.error,
      controlRefusal({ cmd: "theme", dir: 1 }, controlSwitch({ AGENTGLASS_CONTROL_LEVEL: "banana" }))!.error,
      levelRefusal("dialog.prepare", { level: 3, kind: "stage" }, 2),
      levelRefusal("merge.now", { level: 3, kind: "change" }, 3),
      levelRefusal("oops", { kind: "open" }, 2),
    ];
    for (const e of sentences) {
      expect(e, e).not.toMatch(/AGENTGLASS_|_LEVEL|_READONLY|\bunset\b|environment|restart|=\d/);
      expect(e, e).toMatch(/owner|person|no setting allows/);
    }
  });

  test("a level 3 stage at level 2 says what level 3 means", () => {
    const e = levelRefusal("dialog.prepare", { level: 3, kind: "stage" }, 2);
    expect(e).toContain("level 3 door");
    expect(e).toContain("only the person's own click completes");
    expect(e).toContain("this server allows up to level 2");
  });

  test("a level 3 entry that is not a stage is told no setting allows it", () => {
    expect(levelRefusal("merge.now", { level: 3, kind: "change" }, 3)).toContain("no setting allows it");
  });

  test("an entry with no level says it counts as level 3", () => {
    expect(levelRefusal("oops", { kind: "open" }, 2)).toContain("no level, which counts as level 3");
  });

  test("an unknown id is not described: no sentence, so the route answers the bare 400", () => {
    expect(controlRefusal({ cmd: "ui", do: "merge.everything" }, controlSwitch({}))).toBeNull();
    expect(controlRefusal({ cmd: "nope" }, controlSwitch({}))).toBeNull();
    expect(controlRefusal(null)).toBeNull();
    expect(controlRefusal([])).toBeNull();
  });

  test("a door the server allows has nothing to refuse, even with bad arguments", () => {
    expect(controlRefusal({ cmd: "ui", do: "settings.open", args: { page: "nope" } }, controlSwitch({ AGENTGLASS_CONTROL_LEVEL: "1" }))).toBeNull();
    expect(controlRefusal(body, controlSwitch({}))).toBeNull();
  });

  test("the sentence never repeats the arguments", () => {
    const r = controlRefusal({ ...body, args: { id: "diff.wrap", value: "hunter2-secret-looking" } }, controlSwitch({ AGENTGLASS_CONTROL_LEVEL: "1" }))!;
    expect(r.error).not.toContain("hunter2");
    expect(r.error).not.toContain("diff.wrap");
  });

  test("a legacy spelling resolves to its entry", () => {
    expect(entryOfBody({ cmd: "open", what: "finder", path: "/x" })?.id).toBe("finder.open");
    expect(entryOfBody({ cmd: "open", what: "stats" })?.id).toBe("panel.open");
  });
});

// ── the switch cannot be moved from inside ───────────────────────────────────

const ROOT = join(import.meta.dir, "..", "..");
/*
 * The source under `dir`, as git tracks it. Walking the disk instead read the
 * compiled server an install leaves in electron/staging and electron/dist-app:
 * a binary that carries control.ts inside it, so "only control.ts reads the
 * variables" failed on every machine that had run `make desktop-install`.
 */
function walk(dir: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", relative(ROOT, dir)], { cwd: ROOT }).toString();
  return out.split("\0")
    .filter((f) => { const n = f.split("/").pop() ?? ""; return /\.(ts|tsx|js|mjs|cjs)$/.test(n) || (n !== "" && !n.includes(".")); })
    .map((f) => join(ROOT, f));
}

/** Comment lines out, so a sentence about the variable is not a use of it. */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join("\n");

/** The ways a source can write or reach the switch. Exported so the test can be broken on purpose. */
export function switchWrites(src: string): string[] {
  const c = code(src);
  const hits: string[] = [];
  const re = [
    /process\.env\.AGENTGLASS_CONTROL_\w+\s*(=(?!=)|\+=|\?\?=|\|\|=)/,
    /process\.env\[[^\]]*CONTROL[^\]]*\]\s*=(?!=)/,
    /delete\s+process\.env\.AGENTGLASS_CONTROL_/,
    /Object\.assign\(\s*process\.env/,
    /env\.AGENTGLASS_CONTROL_\w+\s*=(?!=)/,
    /\bCONTROL\.(level|readonly)\s*=(?!=)/,
  ];
  for (const r of re) if (r.test(c)) hits.push(String(r));
  return hits;
}

describe("the switch is not agent-writable (source)", () => {
  const files = [...walk(join(ROOT, "server", "src")), ...walk(join(ROOT, "shared")), ...walk(join(ROOT, "web", "src")), ...walk(join(ROOT, "bin")), ...walk(join(ROOT, "electron"))];

  test("the scan reads the tree it thinks it does", () => {
    const rel = files.map((f) => relative(ROOT, f));
    expect(rel).toContain("server/src/control.ts");
    expect(rel).toContain("server/src/index.ts");
    expect(rel).toContain("web/src/lib/uiActions.ts");
    expect(files.length).toBeGreaterThan(100);
  });

  test("no source assigns to either variable or to the process-wide switch object", () => {
    const bad = files.filter((f) => switchWrites(readFileSync(f, "utf8")).length).map((f) => relative(ROOT, f));
    expect(bad).toEqual([]);
  });

  test("only control.ts reads the variables; everything else only talks about them", () => {
    const reads = files.filter((f) => /process\.env[.[][^;\n]*AGENTGLASS_CONTROL_|env\.AGENTGLASS_CONTROL_/.test(code(readFileSync(f, "utf8")))).map((f) => relative(ROOT, f));
    expect(reads).toEqual(["server/src/control.ts"]);
  });

  test("index.ts takes the switch once, at module level, and hands the route its level", () => {
    const src = code(readFileSync(join(ROOT, "server", "src", "index.ts"), "utf8"));
    expect(src.match(/controlSwitch\(/g)?.length).toBe(1);
    expect(src).toMatch(/^const CONTROL = controlSwitch\(\);$/m);
    expect(src).not.toMatch(/\bcontrolLevel\(/);
    expect(src).toContain("parseControlCmd(b, CONTROL.level)");
    expect(src).toContain("describeUiActions(UI_ACTIONS, CONTROL.level)");
  });

  test("no registry entry or argument is about the level, the switch or a grant", () => {
    // `switch` as a whole word: windows.switcher is a window switcher, not the switch.
    const named = /control|level|readonly|read-only|\bswitch\b|grant|escalat/i;
    for (const [id, d] of Object.entries(UI_ACTIONS)) {
      expect(named.test(id.replace(/\./g, " ")), `entry ${id}`).toBe(false);
      for (const a of Object.keys(d.args)) expect(named.test(a), `${id} argument ${a}`).toBe(false);
    }
  });

  test("the route that serves the level only reads it", () => {
    const src = code(readFileSync(join(ROOT, "server", "src", "index.ts"), "utf8"));
    const at = src.indexOf('pathname === "/control/actions"');
    const end = src.indexOf('pathname === "/control" &&', at);
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, end)).toContain('req.method === "GET"');
    expect(src.slice(at, end)).not.toMatch(/CONTROL\b[^.]/);
  });

  // Break it on purpose: each shape of write is seen by the scan.
  test("the scan goes red on each way of writing the switch", () => {
    for (const bad of [
      'process.env.AGENTGLASS_CONTROL_LEVEL = "3";',
      'process.env["AGENTGLASS_CONTROL_LEVEL"] = "3";',
      "delete process.env.AGENTGLASS_CONTROL_READONLY;",
      "Object.assign(process.env, { AGENTGLASS_CONTROL_LEVEL: '3' });",
      'env.AGENTGLASS_CONTROL_LEVEL = "3"',
      "CONTROL.level = 3;",
    ]) expect(switchWrites(bad).length, bad).toBeGreaterThan(0);
    expect(switchWrites("const x = process.env.AGENTGLASS_CONTROL_LEVEL === '1';")).toEqual([]);
    expect(switchWrites("// process.env.AGENTGLASS_CONTROL_LEVEL = 3")).toEqual([]);
  });
});

describe("refusals are logged once per caller per minute, with a count", () => {
  test("the first refusal is a row, the rest are counted, and the next row says how many", () => {
    const t = makeRefusalThrottle(60_000);
    expect(t.note("a", 0)).toEqual({ log: true, suppressed: 0 });
    for (let i = 1; i <= 5; i++) expect(t.note("a", i * 1000), String(i)).toEqual({ log: false, suppressed: 0 });
    expect(t.note("a", 59_999).log).toBe(false);
    expect(t.note("a", 60_000)).toEqual({ log: true, suppressed: 6 });
    expect(t.note("a", 60_001).log).toBe(false);
  });

  test("callers do not share a row", () => {
    const t = makeRefusalThrottle(60_000);
    expect(t.note("a", 0).log).toBe(true);
    expect(t.note("b", 1).log).toBe(true);
    expect(t.note("a", 2).log).toBe(false);
  });

  test("the map does not keep a key per caller ever", () => {
    const t = makeRefusalThrottle(1000);
    for (let i = 0; i < 50; i++) t.note(`k${i}`, i);
    t.note("late", 5_000);
    // Every earlier key has expired; the next note for one starts a fresh row, not a count.
    expect(t.note("k3", 5_001)).toEqual({ log: true, suppressed: 0 });
  });
});

describe("the route (source)", () => {
  const src = code(readFileSync(join(ROOT, "server", "src", "index.ts"), "utf8"));
  const at = src.indexOf('if (pathname === "/control" && req.method === "POST")');
  const route = src.slice(at, src.indexOf('pathname === "/control/result"', at));

  test("a refused request always gets its 403; only the log row goes through the throttle", () => {
    const refusal = route.slice(route.indexOf("const no = controlRefusal("), route.indexOf(", 403)") + 7);
    expect(refusal.indexOf("controlRefusals.note(")).toBeGreaterThan(0);
    expect(refusal.indexOf("controlRefusals.note(")).toBeLessThan(refusal.indexOf("noteAction("));
    expect(refusal).toContain(", 403)");
    // The 403 return is not inside the `if (row.log)` block.
    expect(refusal.slice(refusal.indexOf("if (row.log)"), refusal.indexOf(", 403)"))).toMatch(/\}\s*return json/);
  });

  test("the rate-limit row is throttled the same way, and the 429 is not", () => {
    const rl = route.slice(route.indexOf("controlWriteLimit.hit("), route.indexOf("429") + 4);
    expect(rl).toContain("controlRefusals.note(");
    expect(rl).toContain("429");
  });

  test("control frames go to windows that said hello, and 'no window' counts those", () => {
    expect(route).not.toMatch(/\bbroadcast\(\{ type: "control"/);
    expect(route).toContain("sendControl(");
    expect(route).toContain("controlWindows().length");
    expect(route).not.toContain("clients.size");
    const fn = src.slice(src.indexOf("function controlWindows()"), src.indexOf("function sendControl"));
    expect(fn).toContain("browserSockets.values()");
    expect(fn).toContain("clients.has(");
  });

  test("the frame carries the level the server holds, and the warnings are printed once at boot", () => {
    expect(route).toMatch(/const frame = \{ present, level: CONTROL\.level/);
    expect(src).toMatch(/for \(const w of CONTROL\.warnings\) console\.warn\(/);
  });
});
