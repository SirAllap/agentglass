/*
 * The keys and the stacking of the bench — the two things about a window that
 * floats over everything else that fail on screen and nowhere else.
 *
 * Both were measured in the running app before they were written down here.
 * The keys one is the sharper story: with the caret in a bench terminal,
 * Ctrl+Shift+P reached the app AND the pty, so the palette opened and the shell
 * got the escape sequence — and with nvim in the tab, the next characters typed
 * went into somebody's buffer (`layers.ts` became `yers.ts` and `-- INSERT --`).
 * This is a source-shape test and says so: xterm needs a DOM that `bun test`
 * does not have, so what is pinned is the seam that fixed it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { LAYER } from "../src/lib/layers.ts";

const term = await Bun.file(new URL("../src/components/bench/BenchTerm.tsx", import.meta.url)).text();
const bench = await Bun.file(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url)).text();
const keys = await Bun.file(new URL("../src/lib/keybindings.ts", import.meta.url)).text();
const web = await Bun.file(new URL("../src/components/bench/BenchWeb.tsx", import.meta.url)).text();

describe("a terminal in the bench cedes the app's chords", () => {
  it("asks the live bindings rather than a copy of the defaults", () => {
    // A copy here would leave one key that opens nothing and another that does
    // two things at once the moment the chord is rebound — the reason
    // termKeys.isAppChord reads the bindings instead of listing them.
    expect(term).toContain('import { isAppChord } from "../../lib/termKeys.ts"');
    expect(term).toContain("term.attachCustomKeyEventHandler");
    expect(term).toContain("return !isAppChord(e);");
  });

  it("the bench's own chord is one of them", () => {
    // It has to be, or the window could not be closed from inside its own tab.
    expect(keys).toContain('"bench.toggle": "mod+alt+a"');
  });
});

describe("Escape belongs to what is in the tab", () => {
  it("the window does not close on it", () => {
    /* Every other overlay in this app closes on Escape and this one must not:
       what is usually inside a tab is nvim or a shell, where Escape is the
       most-pressed key there is. */
    expect(bench).toContain('if (e.key === "Escape") { e.stopPropagation(); return; }');
  });
});

describe("a grown bench", () => {
  it("fills everything right of the rail and below the top bar", () => {
    // A percentage inset from the whole app left ~80px a side on a wide screen,
    // and one that covered the rail would hide how a board goes back to its view.
    expect(bench).toContain("const GROWN_GAP = 8;");
    expect(bench).toContain("left: st.grown ? RAIL_W + GROWN_GAP");
    expect(bench).toContain("const GROWN_TOP = TOP_BAR_H + GROWN_GAP;");
    expect(bench).toContain("top: st.grown ? GROWN_TOP");
    expect(bench).toContain("width: st.grown ? `calc(100% - ${RAIL_W + 2 * GROWN_GAP}px)`");
    expect(bench).toContain("height: st.grown ? `calc(100% - ${GROWN_TOP + GROWN_GAP}px)`");
  });
});

describe("where the bench sits", () => {
  it("above the viewer it takes files from", () => {
    // The viewer sends a file here; a window that opened underneath the thing
    // that raised it looks like nothing happened.
    expect(LAYER.bench).toBeGreaterThan(LAYER.viewer);
  });

  it("below the palette that feeds it", () => {
    // The palette is how the next file is found, and it has to stay on top of
    // what it feeds — measured on screen, with a file open in the bench.
    expect(LAYER.palette).toBeGreaterThan(LAYER.bench);
  });

  it("leaves room to slide something between them", () => {
    expect(LAYER.bench - LAYER.viewer).toBeGreaterThanOrEqual(10);
    expect(LAYER.palette - LAYER.bench).toBeGreaterThanOrEqual(10);
  });

  it("the menu closes on a click anywhere that is not the menu", () => {
    /* A backdrop was wrong twice: inside the window it is clipped by the
       window's own overflow, and under the window a click on the terminal — the
       thing most of the window is — never reached it. A capture-phase
       pointerdown has no geometry to get wrong. */
    expect(bench).toContain('document.addEventListener("pointerdown", away, true)');
    expect(bench).toContain('t?.closest?.("[data-bench-plus]")');
  });
});

describe("the browser tab is the browser", () => {
  it("mounts the real one rather than a smaller one written again", () => {
    /* A bare address bar over a `<webview>` was the first attempt: no
       suggestions, no sidebar, no history — the ten percent of a browser that
       is easy to build, and every part it left out is a part somebody uses to
       find the page they wanted. */
    // It mounts none: the workspace holds the one BrowserView and the host lays it over this slot.
    expect(web).not.toContain("<BrowserView");
    expect(web).toContain("registerBrowserSlot");
    // And it names no partition of its own: which session a guest may attach on
    // is the shell's answer, and the browser already asks it.
    expect(web).not.toContain('partition="persist:');
  });

  it("says so instead of drawing an empty rectangle where there is no shell", () => {
    expect(web).toContain("if (!IS_DESKTOP || !HAS_BROWSER)");
  });
});

describe("the agents offered are the agents there are", () => {
  it("offers the one the ticket can actually start", () => {
    /* The ticket does not carry WHICH agent — the client says what, the server
       decides how — so a menu of three started Claude three times. */
    const list = bench.slice(bench.indexOf("const AGENTS"), bench.indexOf("export function FloatingBench"));
    expect(list).toContain('label: "Claude"');
    expect(list).not.toContain("Codex");
    expect(list).not.toContain("Antigravity");
  });
});
