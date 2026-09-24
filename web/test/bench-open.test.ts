/*
 * Opening the bench is a repaint, not a build.
 *
 * Measured in the production bundle in headless Chromium, on a task board of
 * four hundred cards with one card's sixty-comment activity showing: every
 * Ctrl+Alt+A held the main thread for about a second before the window
 * appeared. The causes, each found in a CPU profile or a trace and each pinned
 * below, because each one is the natural way to write the thing:
 *
 *   the window unmounted on close, so the board was carried back to its view
 *   and into the window again on every open (boardHost's move, ~800 ms);
 *   hiding it with `inert`, `visibility` or `pointer-events`, all inherited,
 *   re-styled all seven thousand nodes (100 to 160 ms);
 *   and the board re-rendered for its new `active` inside the opening frame.
 *
 * After: about 65 ms from the key to the first frame with the board in it, and
 * no long task. The DOM work itself needs a document `bun test` does not have,
 * so what is pinned is the source shape that made the difference.
 */
import { describe, expect, it } from "bun:test";

const load = async () => await import(`../src/lib/boardHost.ts?t=${Math.random()}`) as typeof import("../src/lib/boardHost.ts");
const noEl = {} as HTMLElement;

const bench = await Bun.file(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url)).text();
const term = await Bun.file(new URL("../src/components/bench/BenchTerm.tsx", import.meta.url)).text();
const note = await Bun.file(new URL("../src/components/bench/BenchNote.tsx", import.meta.url)).text();
const workspace = await Bun.file(new URL("../src/components/workspace/Workspace.tsx", import.meta.url)).text();

const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const line = (src: string, start: string) => {
  const at = src.indexOf(start);
  return at < 0 ? "" : src.slice(at, src.indexOf("\n", at));
};

describe("closing the bench hides it", () => {
  it("the window is kept once it has been built, not mounted on `open`", () => {
    const c = code(bench);
    expect(c).toContain("{built && (");
    expect(c).not.toMatch(/\{st\.open && \(\s*<Portal/);
    // AnimatePresence is what unmounts on the way out.
    expect(c).not.toContain("AnimatePresence");
    expect(c).toContain("animate={st.open ? SHOWN : HIDDEN}");
  });

  it("its tabs are not gated on `open` either, or closing would drop the board again", () => {
    const c = code(bench);
    expect(c).toContain('{root && tabs.filter((t) => t.kind !== "file" && seen.has(t.id)).map((t) => (');
    expect(c).not.toMatch(/st\.open && tabs\.filter|seen\.has\(t\.id\) && st\.open/);
  });

  it("a place that stays registered and goes off screen keeps the board", async () => {
    // What the kept window relies on: the bench's place goes off screen on
    // close instead of going away, and off screen it moves nothing.
    const h = await load();
    h.registerSlot("rail", "tasks", "rail", noEl, false);
    h.registerSlot("bench", "tasks", "bench", noEl, true);
    h.setSlotVisible("bench", false);
    expect(h.boardHolder("tasks")).toBe("bench");
    expect(h.boardActive("tasks")).toBe(false);
    h.setSlotVisible("bench", true);
    expect(h.boardHolder("tasks")).toBe("bench");
    expect(h.boardActive("tasks")).toBe(true);
  });

  it("hidden without an inherited property flipped on the root", () => {
    const c = code(bench);
    expect(c).not.toMatch(/\.inert\s*=/);
    expect(c).not.toMatch(/\binert[={]/);
    expect(c).not.toMatch(/pointerEvents:/);
    expect(line(c, "const HIDDEN =")).not.toContain("visibility");
    expect(line(c, "const SHOWN =")).not.toContain("visibility");
    // Clipped or content-hidden, the lists' `content-visibility: auto` rows
    // were off screen and came back a frame after the window did.
    expect(c).not.toMatch(/contentVisibility|clipPath/);
    expect(c).toContain("<Portal z={away ? UNDER_THE_APP : LAYER.bench}>");
    // The window's own element: its style and class carry nothing that hides.
    const at = c.indexOf("<motion.div\n              ref={winRef}");
    const root = c.slice(at, c.indexOf("onKeyDown={onKey}", at));
    expect(root.length).toBeGreaterThan(100);
    expect(root).not.toMatch(/visibility|pointerEvents|invisible|pointer-events|inert/);
  });

  it("under #root works because #root fills the page", async () => {
    // Without it a click below #root would land in the hidden window.
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{\s*height: 100%;/);
  });

  it("a web tab is hidden for real while away, so its page is throttled", () => {
    expect(code(bench)).toContain('visibility: t.id === active?.id && !(away && t.kind === "web") ? "visible" : "hidden"');
  });

  it("goes under the app on a timer, which cannot fail to fire", () => {
    const c = code(bench);
    expect(c).toContain("const t = setTimeout(() => setAway(true), FADE_MS);");
    expect(c).toContain("if (st.open && away) setAway(false);");
  });

  it("under the app means under #root, and a portal does not lift it back", async () => {
    expect(code(bench)).toContain("const UNDER_THE_APP = -1;");
    const portal = await Bun.file(new URL("../src/components/Portal.tsx", import.meta.url)).text();
    expect(code(portal)).toContain("const layer = z < 0 ? z : Math.max(z, floor);");
  });

  it("takes the focus and its own menus out on the way", () => {
    const c = code(bench);
    // Refused for as long as it is away, not only taken once: a Tab from the
    // view, or a terminal focusing itself when its session comes up.
    expect(c).toContain('el.addEventListener("focusin", refuse);');
    // On to the top of the app, or every Tab would land in here again.
    expect(c).toContain('document.getElementById("root")?.querySelector<HTMLElement>(FOCUSABLE)');
    expect(c).toContain("if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();");
    expect(c).toMatch(/if \(st\.open \|\| !el\) return;[\s\S]{0,1800}setPickOpen\(false\);\s*setMenuOpen\(false\);/);
  });

  it("a terminal that comes up after the close does not take the caret", () => {
    expect(code(term)).toContain("if (!disposed && activeRef.current) { term.focus(); }");
  });

  it("a note is read again each time it comes on screen", () => {
    const c = code(note);
    expect(c).toContain("if (!active || pending.current) return;");
    // Nor over what was typed while it was being read, or while it saved.
    expect(c).toContain("if (live && !pending.current && edits.current === at)");
    expect(c).toContain("pending.current = !r.ok || edits.current !== mine;");
    expect(c).toContain("}, [root, active]);");
  });
});

describe("a tab is built when it is first on screen", () => {
  it("only tabs that have been looked at are rendered", () => {
    // Two terminal tabs nobody had opened were most of the first open's script
    // time: an xterm each, measuring its cell and laying out its rows.
    expect(code(bench)).toContain("seed && seen.has(reader)");
  });

  it("the reader is counted per checkout", () => {
    // Seen in one checkout, a shared key would build the next checkout's
    // reader, and start its editor, before anybody looked at it.
    expect(code(bench)).toContain("const reader = `reader:${root}`;");
  });
});

describe("the board's new `active` does not hold the opening frame", () => {
  it("is deferred where the board is rendered", () => {
    expect(code(workspace)).toContain(
      "const active = useDeferredValue(useSyncExternalStore(subscribeBoards, () => boardActive(kind), () => false));",
    );
  });
});
