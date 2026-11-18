import { beforeEach, describe, expect, it } from "bun:test";
import type { Clock } from "../src/components/settings/save/clock.ts";
import { _resetSaveToast, getSaveToast, pushSaveToast, undoSaveToast } from "../src/components/settings/save/saveToasts.ts";
import { instantSave, RESTART_MESSAGE } from "../src/components/settings/save/useInstantSave.ts";
import { createTextCommit } from "../src/components/settings/save/textCommit.ts";
import { addItem, entries, joinList, parseList, removeItem } from "../src/components/settings/save/listEdit.ts";
import { createDangerArm } from "../src/components/settings/save/dangerArm.ts";

function fakeClock() {
  let now = 0, id = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const c: Clock = {
    set(fn, ms) { q.set(++id, { at: now + ms, fn }); return id; },
    clear(i) { q.delete(i as number); },
  };
  const tick = (ms: number) => {
    now += ms;
    for (const [k, t] of [...q]) if (t.at <= now) { q.delete(k); t.fn(); }
  };
  return { c, tick };
}

let clk = fakeClock();
beforeEach(() => { clk = fakeClock(); _resetSaveToast(clk.c); });

describe("useInstantSave + toast", () => {
  it("applies at once and shows the toast for 6 s", () => {
    let v = 1;
    instantSave(v, 2, (n) => { v = n; });
    expect(v).toBe(2);
    expect(getSaveToast()?.message).toBe("Saved");
    clk.tick(5999); expect(getSaveToast()).not.toBeNull();
    clk.tick(1); expect(getSaveToast()).toBeNull();
  });
  it("Undo restores the old value through the same setter, once", () => {
    const calls: number[] = [];
    instantSave(1, 2, (n) => calls.push(n), { message: "Saved · applied to open panes" });
    expect(getSaveToast()?.message).toBe("Saved · applied to open panes");
    undoSaveToast(); undoSaveToast();
    expect(calls).toEqual([2, 1]);
    expect(getSaveToast()).toBeNull();
  });
  it("same value does nothing", () => {
    let n = 0;
    instantSave("a", "a", () => n++);
    expect(n).toBe(0); expect(getSaveToast()).toBeNull();
  });
  it("a newer save replaces the older toast and restarts the 6 s", () => {
    pushSaveToast("one", () => {});
    clk.tick(4000);
    pushSaveToast("two", () => {});
    clk.tick(4000);
    expect(getSaveToast()?.message).toBe("two");
    clk.tick(2000);
    expect(getSaveToast()).toBeNull();
  });
});

describe("text commit", () => {
  const mk = (validate?: (v: string) => string | null) => {
    const saved: string[] = [];
    const c = createTextCommit({ value: "a", validate, save: (v) => saved.push(v), clock: clk.c });
    return { c, saved };
  };
  it("does not save while typing; saves on commit", () => {
    const { c, saved } = mk();
    c.type("ab"); expect(saved).toEqual([]);
    c.commit(); expect(saved).toEqual(["ab"]);
  });
  it("invalid: error shown, nothing saved", () => {
    const { c, saved } = mk((v) => (v.length < 3 ? "Too short" : null));
    c.type("ab"); c.commit();
    expect(c.state.error).toBe("Too short"); expect(saved).toEqual([]); expect(c.state.saved).toBe(false);
  });
  it("keeps Saved when the controlled value echoes the save; clears on a different value", () => {
    const { c } = mk();
    c.type("b"); c.commit();
    c.sync("b"); expect(c.state.saved).toBe(true);
    clk.tick(2000); expect(c.state.saved).toBe(false);
    c.type("c"); c.commit(); c.sync("z");
    expect(c.state.saved).toBe(false); expect(c.state.draft).toBe("z");
  });
  it("shows Saved for 2 s", () => {
    const { c } = mk();
    c.type("b"); c.commit();
    expect(c.state.saved).toBe(true);
    clk.tick(1999); expect(c.state.saved).toBe(true);
    clk.tick(1); expect(c.state.saved).toBe(false);
  });
  it("Escape restores the saved value without saving", () => {
    const { c, saved } = mk();
    c.type("zzz"); c.cancel();
    expect(c.state.draft).toBe("a"); expect(saved).toEqual([]);
  });
  it("unchanged value does not save", () => {
    const { c, saved } = mk();
    c.commit(); expect(saved).toEqual([]);
  });
});

describe("list editor", () => {
  const rule = (s: string) => (s.startsWith("Bash(") ? null : `Not a rule: ${s}`);
  it("adds a valid rule", () => {
    const r = addItem(["Bash(rm)"], " Bash(ls) ", rule);
    expect(r).toEqual({ ok: true, list: ["Bash(rm)", "Bash(ls)"] });
  });
  it("rejects bad, empty and duplicate", () => {
    expect(addItem([], "nope", rule)).toEqual({ ok: false, error: "Not a rule: nope" });
    expect(addItem([], "  ", rule).ok).toBe(false);
    expect(addItem(["Bash(a)"], "Bash(a)", rule)).toEqual({ ok: false, error: "Already in the list" });
  });
  it("removes; each change can be undone through the toast", () => {
    let list = ["a", "b"];
    instantSave(list, removeItem(list, "a"), (n) => { list = n; });
    expect(list).toEqual(["b"]);
    undoSaveToast();
    expect(list).toEqual(["a", "b"]);
  });
});

describe("restart-only rows", () => {
  it("toast says takes effect after a restart; Undo restores", () => {
    let v = 1;
    instantSave(v, 2, (n) => { v = n; }, { restartOnly: true });
    expect(getSaveToast()?.message).toBe("Saved · takes effect after a restart");
    expect(RESTART_MESSAGE).toBe(getSaveToast()!.message);
    undoSaveToast(); expect(v).toBe(1);
  });
});

describe("list editor on the stored string", () => {
  const rule = (s: string) => (s.startsWith("Bash(") ? null : `Not a rule: ${s}`);
  it("parse/join keeps the one-string newline format", () => {
    expect(parseList("Bash(a)\n\n  Bash(b) \n")).toEqual(["Bash(a)", "Bash(b)"]);
    expect(joinList(["Bash(a)", "Bash(b)"])).toBe("Bash(a)\nBash(b)");
  });
  it("stored invalid rule is marked, kept, removable, never blocks", () => {
    const list = parseList("Bash(a)\njunk");
    expect(entries(list, rule)).toEqual([{ item: "Bash(a)", error: null }, { item: "junk", error: "Not a rule: junk" }]);
    expect(addItem(list, "Bash(c)", rule)).toEqual({ ok: true, list: ["Bash(a)", "junk", "Bash(c)"] });
    expect(joinList(removeItem(list, "junk"))).toBe("Bash(a)");
  });
  it("save + Undo round-trip the stored string", () => {
    let stored = "Bash(a)";
    instantSave(stored, joinList(removeItem(parseList(stored), "Bash(a)")), (n) => { stored = n; });
    expect(stored).toBe("");
    undoSaveToast(); expect(stored).toBe("Bash(a)");
  });
});

describe("danger action", () => {
  it("Esc/blur (disarm) cancels the armed state", () => {
    let ran = 0;
    const d = createDangerArm({ run: () => ran++, clock: clk.c });
    d.press(); d.disarm();
    expect(d.armed).toBe(false);
    d.press(); expect(ran).toBe(0);
  });
  it("first press arms, does not run", () => {
    let ran = 0;
    const d = createDangerArm({ run: () => ran++, clock: clk.c });
    d.press(); expect(d.armed).toBe(true); expect(ran).toBe(0);
  });
  it("second press within 4 s runs and disarms", () => {
    let ran = 0;
    const d = createDangerArm({ run: () => ran++, clock: clk.c });
    d.press(); clk.tick(3999); d.press();
    expect(ran).toBe(1); expect(d.armed).toBe(false);
  });
  it("disarms after 4 s; the next press only arms again", () => {
    let ran = 0;
    const d = createDangerArm({ run: () => ran++, clock: clk.c });
    d.press(); clk.tick(4000);
    expect(d.armed).toBe(false);
    d.press(); expect(ran).toBe(0); expect(d.armed).toBe(true);
  });
});
