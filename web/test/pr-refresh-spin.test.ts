/*
 * The header refresh icon turns for exactly as long as its request is out.
 *
 * It read "2m · updating" beside an icon that stayed still: the button was fed
 * the flag of whatever write was running, never the read the press had started,
 * so the data updated and nothing on the button said so. It is fed the read now,
 * and a second press while it is out sends nothing. RefreshButton has no hooks,
 * so it is called as a function and the element it returns is inspected; the
 * panel's handler is asserted against its source (no renderer in this project).
 */
import { describe, expect, it } from "bun:test";
import { RefreshButton } from "../src/components/workspace/Chrome.tsx";

type El = { props: Record<string, any> };
const btn = (p: Record<string, unknown>) => RefreshButton({ onRefresh: () => {}, title: "Refresh", ...p } as any) as unknown as El;
const icon = (b: El) => (b.props.children as El);

describe("RefreshButton", () => {
  it("turns and is disabled while its own request is out", () => {
    const b = btn({ spinning: true });
    expect(icon(b).props.className).toBe("agx-turn");
    expect(b.props.disabled).toBe(true);
  });
  it("stands still and is live when nothing is out", () => {
    const b = btn({ spinning: false, busy: false });
    expect(icon(b).props.className).toBeUndefined();
    expect(b.props.disabled).toBeFalsy();
  });
  it("greys for an unrelated write without turning, when the caller says which is which", () => {
    const b = btn({ busy: true, spinning: false });
    expect(icon(b).props.className).toBeUndefined();
    expect(b.props.disabled).toBe(true);
  });
  it("keeps the old meaning for callers that only pass busy", () => {
    const b = btn({ busy: true });
    expect(icon(b).props.className).toBe("agx-turn");
  });
});

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the turn respects reduced motion", () => {
  it("rotates by default and breathes instead under prefers-reduced-motion", () => {
    expect(css).toMatch(/\.agx-turn \{ animation: agx-spin [\d.]+s linear infinite; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.agx-turn \{ animation: agx-breathe/);
  });
});

describe("the panel ties it to the reads the press started", () => {
  const start = code.indexOf("<RefreshButton onRefresh={() => {");
  const handler = code.slice(start, code.indexOf("spinning={refreshing}", start) + 30);
  it("a second press while one is out returns before anything is asked", () => {
    expect(handler).toMatch(/if \(!root \|\| refreshLock\.current\) return;\s*refreshLock\.current = true; setRefreshing\(true\);/);
    expect(handler.indexOf("refreshLock.current = true")).toBeLessThan(handler.indexOf("loadDetail("));
    expect(handler.indexOf("refreshLock.current = true")).toBeLessThan(handler.indexOf("loadList("));
  });
  it("it stops when the reads settle, success or failure, and not on a timer", () => {
    expect(handler).toMatch(/Promise\.allSettled\(reads\)\.finally\(\(\) => \{ refreshLock\.current = false; setRefreshing\(false\); \}\)/);
    expect(handler).not.toMatch(/setTimeout/);
  });
  it("the detail read, the list read and the board's own read are all waited for", () => {
    expect(handler).toContain("reads.push(Promise.resolve(loadDetail(plan.pr, true)))");
    expect(handler).toContain("reads.push(Promise.resolve(loadList(");
    expect(handler).toContain("boardSettle.current = r");
    expect(code).toMatch(/boardSettle\.current\?\.\(\); boardSettle\.current = null;/);
  });
  it("the button is given the read, not the write's flag", () => {
    // `running` is the write in flight; `busy` also includes a read-only visit to a
    // repository with no checkout, where refreshing is the one thing that works.
    expect(handler).toContain("busy={running} spinning={refreshing}");
  });
});
