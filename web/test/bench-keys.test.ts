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
    expect(web).toContain('import { BrowserView } from "../BrowserPanel.tsx"');
    expect(web).toContain('<BrowserView active={active} scope="bench" />');
    // And it names no partition of its own: which session a guest may attach on
    // is the shell's answer, and the browser already asks it.
    expect(web).not.toContain('partition="persist:');
  });

  it("keeps its own strip and shares everything else", () => {
    /* Cookies, logins, profiles, history and bookmarks are the same browser and
       the same person. Which pages are OPEN is not: closing a tab in the bench
       must not close it in the view. */
    const session = readFileSync(new URL("../src/lib/browserSession.ts", import.meta.url), "utf8");
    expect(session).toContain("const keyFor = (scope?: string)");
    expect(session).toContain("`${SESSION_KEY}.${scope}`");
  });

  it("says so instead of drawing an empty rectangle where there is no shell", () => {
    expect(web).toContain("if (!IS_DESKTOP || !HAS_BROWSER)");
  });

  it("does not take the browser the agents drive", () => {
    /*
     * `setBrowserAskHandler` is ONE slot for the window, and this component is
     * mounted twice now. Two registrations meant the last one mounted won it
     * and either one unmounting set it to null — so opening the bench's browser
     * tab once left `agentglass-browser` timing out for the rest of the
     * session, with the view sitting there able to answer. The window still
     * counted as ready, so the failure read as "the browser did not answer in
     * time" rather than as anything actionable.
     */
    const panel = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");
    // The guard sits immediately before each registration, so the two are read
    // as one thing rather than as a rule written somewhere else in the file.
    const before = (needle: string, chars = 900): string => {
      const at = panel.indexOf(needle);
      expect(at).toBeGreaterThan(0);
      return panel.slice(Math.max(0, at - chars), at);
    };
    expect(before("setBrowserAskHandler((ask)")).toContain("if (scope) return;");
    // …and it does not count itself as a window that can answer, either.
    expect(before("const beat = ()")).toContain("if (scope) return;");
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
