import { describe, expect, test } from "bun:test";
import { barCaption } from "../src/components/jira/detail/LifecycleBlocks.tsx";
import { cardLifecycle, type StageView } from "../src/lib/cardLifecycle.ts";

const src = await Bun.file(new URL("../src/components/jira/detail/LifecycleBlocks.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const body = src.slice(src.indexOf("export function LifecycleBlocks("));
const base = { now: 1_000_000, status: "Code review", statusKind: "open" as const, moves: [], plans: [], runs: [], sessions: [], pr: null, checks: null };

describe("the Card tab's work block (variant C)", () => {
  test("one block: no eyebrow labels, no old next box, strip or tiles", () => {
    expect(src).not.toContain("agx-jd-eyebrow");
    expect(src).not.toMatch(/Next action|Timeline ·/);
    expect(src).not.toMatch(/function (NextBox|StageStrip|Tiles)\b/);
    expect(css).not.toContain(".agx-jd-eyebrow");
    expect((body.match(/<section/g) ?? []).length).toBe(1);
  });
  test("chips draw only the facts that exist", () => {
    const none = cardLifecycle(base);
    expect(none.tiles.find((t) => t.id === "cost")).toBeUndefined();
    expect(none.prNumber).toBeNull();
    expect(src).toContain("if (!cost && life.prNumber === null && !checks) return null;");
    expect(src).toContain("{cost && <span");
    expect(src).toContain("{checks && <span");
    const pr = cardLifecycle({ ...base, pr: { number: 21530, state: "OPEN", url: "https://x/y/pull/21530" }, checks: { total: 84, success: 58, failure: 0, pending: 26, allDone: false, at: 1 } });
    expect(pr.prNumber).toBe(21530);
    expect(pr.tiles.find((t) => t.id === "checks")?.value).toBe("58/84");
  });
  test("a chip that opens something is a button", () => {
    expect(src).toMatch(/<button type="button" className="agx-jd-chip" data-open onClick=\{onPr\}/);
  });
  test("the disclosure is a button with aria-expanded and opens steps and timeline in place", () => {
    expect(src).toMatch(/<button type="button" className="agx-jd-more" aria-expanded=\{open\}/);
    expect(src).toContain('"Show steps"');
    expect(body.indexOf("{open && (")).toBeGreaterThan(body.indexOf("agx-jd-more"));
    expect(body.slice(body.indexOf("{open && ("))).toContain("<StageList");
    expect(body.slice(body.indexOf("{open && ("))).toContain("<Timeline");
  });
  test("the caption reads \"PR 5 of 7\" and the status pill is upper case", () => {
    const st = (state: StageView["state"], id: StageView["id"]): StageView => ({ id, label: id === "pr" ? "PR" : id, state, at: null });
    const ids: StageView["id"][] = ["picked", "plan", "session", "branch", "pr", "qa", "merge"];
    const stages = ids.map((id, n) => st(n < 4 ? "done" : n === 4 ? "current" : "todo", id));
    expect(barCaption(stages)).toBe("PR 5 of 7");
    expect(barCaption(ids.map((id) => st("todo", id)))).toBe("picked 1 of 7");
    expect(barCaption(stages, true)).toBe("PR errored");
    const sess = ids.map((id, n) => st(n < 2 ? "done" : n === 2 ? "current" : "todo", id));
    sess[2]!.label = "Session";
    expect(barCaption(sess, true)).toBe("Session errored");
    expect(src).toContain("barCaption(life.stages, bad)");
    expect(src).toContain("life.status.toUpperCase()");
    expect(cardLifecycle(base).status).toBe("Code review");
  });
  test("reduced motion: the block animates nothing", () => {
    const block = css.split("\n").filter((l) => /^\.agx-jd-(work|chip|seg|more|steps)/.test(l)).join("\n");
    expect(block).not.toMatch(/animation|transition/);
  });
});
