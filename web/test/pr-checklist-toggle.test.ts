/*
 * A REAL CHECKBOX, ONLY WHERE IT IS THE READER'S TO CHECK.
 *
 * "GitHub already does that without hand-editing the body, by marking it as a
 * real checkbox" — GitHub lets a checklist box be clicked directly, and
 * this panel drew one that only looked like it could. `toggleChecklistItem`
 * (locked in pr-markdown.test.ts) is the write; what belongs here is the
 * WIRING — which surface gets a live checkbox and which stays read-only,
 * since `Md` is the one renderer every body in this panel goes through, from
 * a bot's coverage table to somebody else's review comment, and only ONE of
 * those is a body this reader is allowed to edit at all.
 *
 * Read from source: `Md` renders through a `<Portal>`-free but still
 * effect-driven tree, and there is no DOM under `bun test` to click a real
 * checkbox in — same compromise pr-card-picker.test.ts makes for the same
 * reason.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("who gets a live checkbox", () => {
  test("only the description's own render passes onToggleTask", () => {
    const calls = [...src.matchAll(/<Md body=\{[^}]*\}[^/]*\/>/g)].map((m) => m[0]);
    expect(calls.length, "no Md call sites found — the file shape moved").toBeGreaterThan(5);
    const wired = calls.filter((c) => c.includes("onToggleTask"));
    expect(wired, "a comment, a review, or a bot's digest is not this reader's body to rewrite")
      .toHaveLength(1);
    expect(wired[0]).toContain("d.body");
  });

  test("nothing is passed while a write is already running", () => {
    const i = src.indexOf("{d.body.trim() ? <Md body={d.body}");
    expect(i, "the description's own render").toBeGreaterThan(-1);
    expect(src.slice(i, i + 200)).toContain("onToggleTask={busy ? undefined : onToggleTask}");
  });
});

describe("the checkbox is only interactive when Md was asked for it", () => {
  const listFn = src.slice(src.indexOf("function MdList("), src.indexOf("function Block("));

  test("MdList renders a real control only when wiring is passed down", () => {
    expect(listFn).toContain("wiring && taskIndex >= 0");
    expect(listFn).toContain('role="checkbox"');
    // The read-only shape survives as the fallback — a comment's checklist
    // still shows ticked or not, it just cannot be clicked.
    expect(listFn).toContain('<span className="agx-box" data-on={it.checked ? "1" : "0"}>');
  });

  test("a nested list carries the same wiring its parent got, not a fresh one", () => {
    expect(listFn).toContain("<MdList items={kids} ordered={!!kids[0]!.ordered} wiring={wiring} />");
  });

  test("a <details> fold carries it to its own blocks too", () => {
    const blockFn = src.slice(src.indexOf("function Block("), src.indexOf("function Block(") + 3000);
    expect(blockFn).toContain("<Block key={i} b={inner} wiring={wiring} />");
  });
});

describe("one counter for the whole body", () => {
  test("Md resets it once per render, not once per list", () => {
    const mdFn = src.slice(src.indexOf("export function Md("), src.indexOf("export function Md(") + 3000);
    expect(mdFn).toContain("const nextTask = useRef(0);");
    expect(mdFn).toContain("nextTask.current = 0;");
    // Passed to every top-level block the same way a details fold passes it
    // to its own — see the describe block above.
    expect(mdFn).toMatch(/<Block key=\{i\} b=\{b\} wiring=\{wiring\} \/>/);
  });

  test("the callback hands the caller a whole new body, never just an index", () => {
    const mdFn = src.slice(src.indexOf("export function Md("), src.indexOf("export function Md(") + 3000);
    expect(mdFn).toContain("onToggle: (i) => onToggleTask(toggleChecklistItem(body, i))");
  });
});
