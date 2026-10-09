/*
 * The bell in a PR's header: what it says is decided by the pure helpers, and
 * how it is wired (one store for both views, a popup that opens the PR inside
 * the app, an exception to the quiet-by-default rule that is written down) is a
 * rule about source, so it is asserted against source. There is no renderer
 * here. Comments are stripped before asserting a word is absent.
 */
import { describe, expect, it } from "bun:test";
import type { PrWatch } from "../../shared/types.ts";
import { bellState, hasActiveWatch, ruleLabel, sameRule, setPrWatchState, watchesOf } from "../src/lib/prWatchStore.ts";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const src = async (p: string) => strip(await Bun.file(new URL(p, import.meta.url)).text());
const menu = await src("../src/components/PrWatchMenu.tsx");
const panel = await src("../src/components/PrPanel.tsx");
const notify = await src("../src/lib/sysNotify.ts");
const live = await src("../src/lib/useLive.ts");

/** The body of `function name(` to its own closing brace. */
function body(text: string, header: string): string {
  const i = text.indexOf(header);
  expect(i).toBeGreaterThan(-1);
  let depth = 0;
  for (let j = text.indexOf(") {\n", i) + 2; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return text.slice(i, j + 1);
  }
  throw new Error("unbalanced");
}

const w = (over: Partial<PrWatch>): PrWatch => ({ id: "1", repo: "acme/orbit", number: 7, rule: { type: "ci-pass" }, active: true, ...over });

describe("what the bell says", () => {
  it("off with no watches, on while any waits, fired with the last result once all are spent", () => {
    expect(bellState([]).kind).toBe("off");
    expect(bellState([w({})]).kind).toBe("on");
    expect(bellState([w({ active: false, lastAt: 5, lastText: "CI passed" })])).toMatchObject({ kind: "fired", last: { lastText: "CI passed" } });
    // one spent, one waiting: still being watched, and the spent one is still shown
    expect(bellState([w({ active: false, lastAt: 5, lastText: "CI failed: a" }), w({ id: "2", rule: { type: "comment" } })]))
      .toMatchObject({ kind: "on", waiting: 1, last: { lastText: "CI failed: a" } });
  });
  it("watches are per repository AND number", () => {
    const s = { watches: [w({}), w({ id: "2", number: 8 }), w({ id: "3", repo: "acme/other" })], presets: [] };
    expect(watchesOf(s, "acme/orbit", 7).map((x) => x.id)).toEqual(["1"]);
  });
  it("labels every rule, and check patterns say which outcome", () => {
    expect(ruleLabel({ type: "check", match: "evals", on: "fail" })).toBe("Check ~evals fails");
    expect(ruleLabel({ type: "check", match: "evals", on: "either" })).toBe("Check ~evals fails or passes");
    expect(sameRule({ type: "check", match: "Evals", on: "fail" }, { type: "check", match: "evals", on: "fail" })).toBe(true);
    expect(sameRule({ type: "check", match: "evals", on: "fail" }, { type: "check", match: "evals", on: "pass" })).toBe(false);
  });
});

describe("one event, one notification", () => {
  it("a watch of that kind on that PR is what makes the older talk/ci notes step aside", () => {
    setPrWatchState({ watches: [w({ rule: { type: "comment" } }), w({ id: "2", rule: { type: "ci-pass" }, active: false }), w({ id: "3", number: 9, rule: { type: "ci-fail" } })], presets: [] });
    expect(hasActiveWatch("acme/orbit", 7, ["comment"])).toBe(true);
    expect(hasActiveWatch("acme/orbit", 7, ["ci-pass", "ci-fail"])).toBe(false); // fired already: the ci note may speak
    expect(hasActiveWatch("acme/orbit", 9, ["ci-pass", "ci-fail"])).toBe(true);
    expect(hasActiveWatch("acme/other", 7, ["comment"])).toBe(false);
    setPrWatchState({ watches: [], presets: [] });
  });
  it("useLive gives way in both frames, before its own gate", () => {
    const t = body(live, 'if (frame.type === "talk") {');
    expect(t.indexOf('hasActiveWatch(t.repo, t.number, ["comment"])')).toBeGreaterThan(-1);
    expect(t.indexOf("hasActiveWatch")).toBeLessThan(t.indexOf("talkShouldNotify(t)"));
    const c = body(live, 'if (frame.type === "ci") {');
    expect(c).toContain('hasActiveWatch(frame.data.repo, frame.data.number, ["ci-pass", "ci-fail"])');
    expect(c.indexOf("hasActiveWatch")).toBeLessThan(c.indexOf("ciShouldNotify("));
  });
  it("a fire is shown once per seq, tagged so two windows fold, acknowledged, and the queue is read on every connect", () => {
    const f = body(notify, "export function fireWatchAlert(");
    expect(f).toContain("shownFires.has(f.seq)");
    expect(f).toContain("api.prWatchAck(f.seq)");
    expect(f).toContain("tag: `pr-watch-${f.seq}`");
    expect(body(notify, "function popup(")).toContain("tag: a.tag");
    expect(body(notify, "export async function deliverPendingWatchFires(")).toContain("api.prWatchPending()");
    const init = body(live, 'if (frame.type === "initial") {');
    expect(init).toContain("deliverPendingWatchFires()");
    expect(init).toContain("reloadPrWatches()");
  });
});

describe("wiring", () => {
  it("the header mounts the bell with its checkout and repository", () => {
    expect(body(panel, "function Masthead(")).toContain("<PrWatchMenu root={root} repo={repo} d={d} />");
    expect(panel).toContain("root={root} repo={repo?.nameWithOwner ?? \"\"}");
  });
  it("the bell reads the shared store and writes through the server, not local state", () => {
    expect(menu).toContain("usePrWatchState()");
    expect(menu).toContain("api.prWatchAdd(");
    expect(menu).toContain("api.prWatchRemove(");
    expect(menu).not.toContain("localStorage");
    expect(menu).toContain('import { Select } from "./Select.tsx"');
    expect(menu).not.toMatch(/<select|type="checkbox"/); // the house components, not native ones
  });
  it("the comment rule says it stays on", () => {
    expect(menu).toContain("stays on until you turn it off");
  });
  it("the menu uses the house dismiss hook, house Select and switch, and the icon uses the house size", () => {
    expect(menu).toContain("useDismiss(open, box"); // Escape and outside click, the house hook
    expect(menu).toContain("ICON.xs");
    expect(menu).not.toMatch(/size=\{\d+\}/);
  });
  it("a firing raises ONE popup that opens the PR inside the app, never the external browser", async () => {
    const f = body(notify, "export function fireWatchAlert(");
    expect(f).toContain("watchPayload(f)"); // the target travels in the payload: a PR, by repo and number
    expect(await Bun.file(new URL("../../shared/notifyPayload.ts", import.meta.url)).text()).toContain('kind: "pr", repo: f.repo, number: f.number');
    expect(f).toContain("popup(");
    expect(f).toContain('"reminders"'); // the opt-in kind, not `idle`
    expect(f).not.toContain("openExternal");
    expect(f).not.toContain("window.open");
    // The ROW is urgency 1: a 2 there keeps the strip lit, the permanent notification he does not want.
    expect(f).toMatch(/recordNote\(\{[^}]*urgency: 1/);
    expect(f).not.toContain("interrupt"); // and the popup is what he asked for, so Quiet does not gate it
    expect(body(notify, "function popup(")).toContain("goto?.(dest)");
  });
  it("the popup still closes itself: a watch notification is never sticky", () => {
    const p = body(notify, "function popup(");
    expect(p).toContain("setTimeout(");
    // Critical only for the window nobody is looking at, and it still closes itself after BLOCKING_POPUP_MS.
    const f = body(notify, "export function fireWatchAlert(");
    expect(f.indexOf("windowFocused()")).toBeGreaterThan(-1);
    expect(f.indexOf("windowFocused()")).toBeLessThan(f.indexOf("popup({"));
    expect(f).toContain("urgency: 2");
    expect(p).toContain("a.urgency === 2 ? BLOCKING_POPUP_MS : POPUP_MS");
  });
  it("both frames are handled, and the exception to the quiet default is written down", async () => {
    expect(live).toContain('frame.type === "prwatch"');
    expect(live).toContain("fireWatchAlert(frame.data)");
    expect(await Bun.file(new URL("../src/lib/sysNotify.ts", import.meta.url)).text()).toContain("NOT about an agent blocked on the");
  });
});
