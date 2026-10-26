/*
 * The bell in a PR's header: what it says is decided by the pure helpers, and
 * how it is wired (one store for both views, a popup that opens the PR inside
 * the app, an exception to the quiet-by-default rule that is written down) is a
 * rule about source, so it is asserted against source. There is no renderer
 * here. Comments are stripped before asserting a word is absent.
 */
import { describe, expect, it } from "bun:test";
import type { PrCheck, PrWatch } from "../../shared/types.ts";
import { bellState, ciPassRule, firedOk, hasActiveWatch, ignorableNames, ignoredOf, moreIgnorableNames, ruleLabel, sameRule, setPrWatchState, toggleIgnored, watchPhase, watchesOf } from "../src/lib/prWatchStore.ts";

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

describe("what the chip says about the run it is watching", () => {
  const A = "aaaaaaa1111111111111111111111111111aaaaa";
  const B = "bbbbbbb2222222222222222222222222222bbbbb";
  it("names the head being watched", () => {
    expect(watchPhase([w({ head: A })])).toEqual({ kind: "watching", text: "Watching run on aaaaaaa" });
  });
  it("after Update branch: waiting for the head to move, then for the new head's checks", () => {
    expect(watchPhase([w({ head: A, sync: { state: "waiting", from: A } })]))
      .toEqual({ kind: "waiting", text: "Waiting for new run (head aaaaaaa → …)" });
    expect(watchPhase([w({ head: B, sync: { state: "moved", from: A } })]))
      .toEqual({ kind: "waiting", text: "Waiting for new run (head aaaaaaa → bbbbbbb)" });
  });
  it("a sync that moved nothing says so in words", () => {
    expect(watchPhase([w({ head: A, sync: { state: "unchanged", from: A } })]))
      .toEqual({ kind: "unchanged", text: "Update did not change the head — still watching the old run (aaaaaaa)" });
  });
  it("says nothing for a spent watch, a comment-only watch or no head read yet", () => {
    expect(watchPhase([])).toBeNull();
    expect(watchPhase([w({})])).toBeNull();
    expect(watchPhase([w({ active: false, head: A })])).toBeNull();
    expect(watchPhase([w({ rule: { type: "comment" }, head: A })])).toBeNull();
  });
  it("the chip, its tooltip and the menu use it, with the house button and no new size", () => {
    const m = body(menu, "export function PrWatchMenu(");
    expect(m).toContain("watchPhase(");
    expect(m).toContain('phase?.kind === "waiting" ? "Waiting for new run"');
    expect(m).toContain("phase.text");
    expect(m).toContain("data-pr-watch-phase");
  });
});

describe("All CI passed, ignoring some checks", () => {
  const chk = (name: string, state: PrCheck["state"], extra: Partial<PrCheck> = {}): PrCheck => ({ name, workflow: "", state, done: state !== "pending", ...extra });
  const ci = (...ignore: string[]): PrWatch["rule"] => ({ type: "ci-pass", ignore });

  it("the row says how many are ignored, and nothing extra when none are", () => {
    expect(ruleLabel({ type: "ci-pass" })).toBe("All CI passed");
    expect(ruleLabel(ci())).toBe("All CI passed");
    expect(ruleLabel(ci("e2e-flaky"))).toBe("All CI passed, except 1");
    expect(ruleLabel(ci("a", "b", "c"))).toBe("All CI passed, except 3");
  });
  it("it is still the same rule whatever its list, so the row toggles one watch", () => {
    expect(sameRule({ type: "ci-pass" }, ci("a"))).toBe(true);
    expect(sameRule(ci("a"), ci("b"))).toBe(true);
    expect(sameRule(ci("a"), { type: "ci-fail" })).toBe(false);
  });
  it("the list on screen is the waiting watch's, else the last one that fired, else empty", () => {
    expect(ignoredOf([])).toEqual([]);
    expect(ignoredOf([w({ rule: { type: "comment" } })])).toEqual([]);
    expect(ignoredOf([w({ rule: ci("old"), active: false }), w({ id: "2", rule: ci("now") })])).toEqual(["now"]);
    expect(ignoredOf([w({ rule: ci("old"), active: false })])).toEqual(["old"]);
  });
  it("pressing a chip puts a name in the list and takes it out again, leaving the others", () => {
    expect(toggleIgnored([], "a")).toEqual(["a"]);
    expect(toggleIgnored(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleIgnored(["a"], "b")).toEqual(["a", "b"]);
  });
  it("an empty list is sent as the bare rule, so un-ignoring the last one clears it on the server", () => {
    expect(ciPassRule([])).toEqual({ type: "ci-pass" });
    expect(ciPassRule(["a"])).toEqual({ type: "ci-pass", ignore: ["a"] });
  });
  it("chips up front are the checks that can hold it back, once each, plus what is already ignored", () => {
    const all = [chk("lint", "success"), chk("e2e-flaky", "failure"), chk("build", "pending"), chk("docs", "skipped"),
      chk("e2e-flaky", "failure", { event: "push" }), chk("deploy-preview", "failure", { cancelled: true })];
    expect(ignorableNames(all, [])).toEqual(["build", "deploy-preview", "e2e-flaky"]);
    expect(ignorableNames(all, ["lint", "gone-job"])).toEqual(["build", "deploy-preview", "e2e-flaky", "gone-job", "lint"]);
    expect(ignorableNames([chk("lint", "success")], [])).toEqual([]);
  });
  it("'+N more' holds the rest, so up front plus more is every check name the PR has", () => {
    const all = [chk("lint", "success"), chk("e2e-flaky", "failure"), chk("build", "pending"), chk("docs", "skipped"),
      chk("e2e-flaky", "failure", { event: "push" }), chk("deploy-preview", "failure", { cancelled: true })];
    expect(moreIgnorableNames(all, [])).toEqual(["docs", "lint"]);
    expect(moreIgnorableNames(all, ["lint"])).toEqual(["docs"]);
    expect([...ignorableNames(all, []), ...moreIgnorableNames(all, [])].sort()).toEqual([...new Set(all.map((c) => c.name))].sort());
    expect(moreIgnorableNames([chk("lint", "success")], [])).toEqual(["lint"]); // nothing failing: only the chip
    expect(moreIgnorableNames([], [])).toEqual([]);
  });
  it("a name with 'fail' in it after the verdict does not turn a pass into a failure", () => {
    expect(firedOk(w({ lastText: "CI passed on abc1234: ignoring 1: detect-failures" }))).toBe(true);
    expect(firedOk(w({ lastText: "CI failed on abc1234: lint" }))).toBe(false);
    expect(firedOk(w({ lastText: "evals failed: evals (py3.13)" }))).toBe(false);
    expect(firedOk(w({ lastText: "CI passed" }))).toBe(true);
  });
  it("the menu draws the chips as pressed toggles in a labelled group, and stays quiet about it when none apply", () => {
    expect(menu).toContain("aria-pressed={ignored.includes(n)}");
    expect(menu).toContain('role="group" aria-label="Checks All CI passed does not wait for"');
    expect(menu).toContain("No checks on this pull request yet");
    expect(menu).toContain(">Ignore:</span>"); // the chips say what they are before one is pressed
    expect(menu).toContain("ciPassRule(ignored)");
  });
  it("the chips are written through the same add route, only while the rule is on, and staged otherwise", () => {
    const at = menu.indexOf("const ignore = (name: string) =>");
    expect(at).toBeGreaterThan(-1);
    const i = menu.slice(at, menu.indexOf("\n  };", at)); // to the arrow's own closing brace
    expect(i).toContain("api.prWatchAdd(root, d.number, d.title, ciPassRule(next))");
    expect(i).toContain('waiting({ type: "ci-pass" })');
    expect(i.indexOf("setStaged(next)")).toBeLessThan(i.indexOf("api.prWatchAdd"));
  });
  it("applying the default says it keeps the PR's own ignores, and still sends one request", () => {
    expect(menu).toContain(">Apply default, keep ignores</Button>");
    expect(menu).toContain("are added to the ones this pull request already ignores");
    expect(menu).toContain("api.prWatchApply(root, d.number, d.title)");
    expect(menu).not.toContain("Apply my default");
  });
  it("the popover never outgrows a short window: it scrolls inside itself, so the controls at the bottom stay reachable", () => {
    expect(menu).toMatch(/minWidth: 268, maxHeight: "calc\(100vh - \d+px\)", overflowY: "auto" \}\} data-pr-watch-menu>/);
  });
  it("the block is indented under the rule's label and muted while the rule is off, its chips still pressable", () => {
    expect(menu).toContain('className="flex flex-wrap gap-1 pl-9 pr-1" style={waiting(rule) ? undefined : { opacity: 0.5 }}');
    expect(menu).toContain('data-pr-watch-ignore={waiting(rule) ? "on" : "off"}');
    const chip = menu.slice(menu.indexOf('<button key={n} type="button" className="agx-inline-add'), menu.indexOf("</button>", menu.indexOf('<button key={n} type="button" className="agx-inline-add')));
    expect(chip).not.toContain("disabled"); // muted, not dead
  });
  it("an ignored chip wears the eye-off icon in a slot every chip reserves, so a press never changes a chip's width", () => {
    expect(menu).toContain("EyeOffIcon");
    expect(menu).toContain('visibility: ignored.includes(n) ? "visible" : "hidden"');
    expect(menu).toContain("width: ICON.xs, height: ICON.xs");
    expect(menu).toContain('aria-hidden="true"><EyeOffIcon size={ICON.xs} />'); // the state is said by aria-pressed, not by the picture
    expect(menu).toContain("aria-pressed={ignored.includes(n)}");
  });
  it("the popover is three blocks, one thin divider between each, and the default buttons' divider is not doubled", () => {
    const dividers = menu.match(/<div style=\{\{ borderTop: LINE, margin: "4px 0" \}\} \/>/g) ?? [];
    expect(dividers.length).toBe(2);
    expect(menu.indexOf("borderTop: LINE")).toBeLessThan(menu.indexOf("A specific check</div>"));
    expect(menu.lastIndexOf("borderTop: LINE")).toBeGreaterThan(menu.indexOf("A specific check</div>"));
    expect(menu.lastIndexOf("borderTop: LINE")).toBeLessThan(menu.indexOf("Save as my default"));
  });
  it("no timer joins the menu, and the pressed chip is styled with the house tokens, not new ones", async () => {
    expect(menu).not.toMatch(/setInterval|setTimeout/);
    const css = (await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text()).split("\n").find((l) => l.startsWith('.agx-inline-add[aria-pressed="true"]'))!;
    expect(css).not.toBeUndefined();
    expect(css).not.toMatch(/#[0-9a-f]{3,6}|rgb\(|px/i);
    expect(css).toContain("var(--surface-inset)"); // an ignored chip sits on the muted surface and keeps its strike-through
    expect(css).toContain("line-through");
  });
});
