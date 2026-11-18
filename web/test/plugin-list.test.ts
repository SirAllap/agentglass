import { describe, expect, test } from "bun:test";
import { compactLine, groupInstalled, orderInstalled, pluginHeadChips, pluginNavNeed, pluginState, pluginTallyStore, systemHeadline, tallyInstalled } from "../src/lib/pluginList.ts";

const base = { enabled: false, running: false, approvedFingerprint: "a", fingerprint: "a", hadApproval: true };
const mk = (name: string, o: Partial<typeof base> = {}) => ({
  name, publisher: "Acme", resolvedCommit: null, source: { kind: "local-path", path: "/x" }, ...base, ...o,
}) as never as import("../../shared/types.ts").PublicPlugin;

describe("pluginState", () => {
  test("running, off, not running, not approved, asks again", () => {
    expect(pluginState({ ...base, enabled: true, running: true })).toEqual(["Running", "ok"]);
    expect(pluginState(base)).toEqual(["Off", "off"]);
    expect(pluginState({ ...base, enabled: true })).toEqual(["Enabled, not running", "err"]);
    expect(pluginState({ ...base, fingerprint: "b", hadApproval: false })).toEqual(["Not approved", "warn"]);
    expect(pluginState({ ...base, fingerprint: "b" })).toEqual(["Asks again", "warn"]);
  });
});

describe("orderInstalled", () => {
  test("empty stays empty", () => expect(orderInstalled([], () => false)).toEqual([]));
  test("needs-you, stopped, update, running, off; names within a group", () => {
    const list = [
      mk("off-b"), mk("run-z", { enabled: true, running: true }), mk("run-a", { enabled: true, running: true }),
      mk("upd", { enabled: true, running: true }), mk("stop", { enabled: true }), mk("ask", { fingerprint: "b" }), mk("off-a"),
    ];
    const out = orderInstalled(list, (p) => p.name === "upd").map((p) => p.name);
    expect(out).toEqual(["ask", "stop", "upd", "run-a", "run-z", "off-a", "off-b"]);
  });
  test("does not mutate and keeps 40 plugins", () => {
    const list = Array.from({ length: 40 }, (_, i) => mk(`p${String(40 - i).padStart(2, "0")}`));
    const before = list.map((p) => p.name);
    const out = orderInstalled(list, () => false);
    expect(out).toHaveLength(40);
    expect(list.map((p) => p.name)).toEqual(before);
    expect(out[0]!.name).toBe("p01");
  });
});

describe("compactLine", () => {
  test("publisher and version; update only when listed", () => {
    expect(compactLine(mk("a"), false)).toBe("by Acme · local");
    expect(compactLine({ ...mk("a"), resolvedCommit: "abcdef0123" }, true)).toBe("by Acme · abcdef0 · update available");
  });
});

describe("one tally for the whole page", () => {
  // ask (approval), stop (stopped), upd (update, running), two running, two off.
  const list = [
    mk("off-b"), mk("run-z", { enabled: true, running: true }), mk("run-a", { enabled: true, running: true }),
    mk("upd", { enabled: true, running: true }), mk("stop", { enabled: true }), mk("ask", { fingerprint: "b" }), mk("off-a"),
  ];
  const upd = (p: { name: string }) => p.name === "upd";
  const t = tallyInstalled(list, upd);

  test("each plugin is in one bin; running counts every live process", () => {
    expect(t).toEqual({ total: 7, on: 2, off: 2, approval: 1, stopped: 1, update: 1, needsYou: 3, running: 3 });
    expect(t.on + t.off + t.needsYou).toBe(t.total);
  });

  test("groups: Needs you, Running, Off, in list order, empty ones left out", () => {
    const g = groupInstalled(list, upd);
    expect(g.map((x) => [x.label, x.items.map((p) => p.name)])).toEqual([
      ["Needs you", ["ask", "stop", "upd"]], ["Running", ["run-a", "run-z"]], ["Off", ["off-a", "off-b"]],
    ]);
    expect(groupInstalled([mk("x")], () => false).map((x) => x.label)).toEqual(["Off"]);
    expect(groupInstalled([], () => false)).toEqual([]);
  });

  test("the header chips add up to the Needs you group", () => {
    const chips = pluginHeadChips(t);
    expect(chips).toEqual([
      { tone: "ok", text: "3 running" }, { tone: "warn", text: "1 needs approval" },
      { tone: "err", text: "1 stopped" }, { tone: "info", text: "1 update" },
    ]);
    const needs = chips.slice(1).reduce((n, c) => n + Number.parseInt(c.text, 10), 0);
    expect(needs).toBe(groupInstalled(list, upd)[0]!.items.length);
    expect(pluginHeadChips(tallyInstalled([], () => false))).toEqual([]);
  });

  test("headline: worst first, nothing installed said plainly", () => {
    expect(systemHeadline(t)).toEqual({ text: "3 plugins need you", tone: "err" });
    expect(systemHeadline(tallyInstalled([mk("ask", { fingerprint: "b" })], () => false))).toEqual({ text: "1 plugin needs you", tone: "warn" });
    expect(systemHeadline(tallyInstalled([mk("a", { enabled: true, running: true }), mk("b")], () => false))).toEqual({ text: "1 of 2 running", tone: "ok" });
    expect(systemHeadline(tallyInstalled([], () => false))).toEqual({ text: "Nothing installed yet", tone: "off" });
  });

  test("nav mark: the Needs you count, stopped named first", () => {
    expect(pluginNavNeed(t)).toEqual({ count: 3, title: "1 stopped · 1 needs approval · 1 update" });
    expect(pluginNavNeed(tallyInstalled([mk("a", { enabled: true, running: true })], () => false))).toBeNull();
  });
});

describe("the nav mark keeps the page's tally after the page closes", () => {
  test("1 stopped and 1 update stay 2 in the store; a fresh open clears it", () => {
    const t = tallyInstalled([mk("a", { enabled: true, running: false }), mk("b", { enabled: true, running: true })], (p) => p.name === "b");
    let calls = 0;
    const off = pluginTallyStore.subscribe(() => { calls++; });
    pluginTallyStore.set(t);
    pluginTallyStore.set({ ...t });
    expect(calls).toBe(1);
    expect(pluginNavNeed(pluginTallyStore.get()!)).toEqual({ count: 2, title: "1 stopped · 1 update" });
    pluginTallyStore.set(null);
    expect(pluginTallyStore.get()).toBeNull();
    off();
  });
});
