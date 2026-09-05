/*
 * The pull request of the pane you are typing in, from the keyboard.
 *
 * The mock promised every button on a pane a keyboard twin. The obvious
 * spelling was tmux's own — prefix + p — and that is exactly what it cannot be:
 * prefix + p is "previous window", prefix + d is detach and prefix + c is a new
 * window. "Those are going to collide with binds that are already assigned." Taking
 * the three chords somebody uses most, to give them one they use rarely, is a
 * bad trade.
 *
 * So it is an app chord. It never reaches tmux at all, it is rebindable in
 * Settings ▸ Shortcuts like the others, and it falls through when there is
 * nothing to open rather than being swallowed by a view that cannot answer.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { APP_CHORD_DEFAULTS, APP_CHORD_LABELS, chordFromEvent } from "../src/lib/keybindings.ts";

const read = (p: string) => readFileSync(new URL("../src/" + p, import.meta.url), "utf8");

describe("the chords", () => {
  test("all four are registered, so Settings can rebind them", () => {
    for (const id of ["pane.git", "pane.diff", "pane.pr", "pane.card"] as const) {
      expect(APP_CHORD_DEFAULTS[id]).toBeTruthy();
      expect(APP_CHORD_LABELS[id].label).toBeTruthy();
    }
    expect(APP_CHORD_LABELS["pane.pr"].label).toBe("This pane's pull request");
  });

  test("the digits read the block they belong to", () => {
    /* "Maybe it could be ctrl alt 1/2/3/4, I think that's easier" — and it is,
       because the block is a 2×2 read the same way: 1 and 2 on top are the
       checkout, 3 and 4 underneath are the work. */
    expect(APP_CHORD_DEFAULTS["pane.git"]).toBe("mod+alt+1");
    expect(APP_CHORD_DEFAULTS["pane.diff"]).toBe("mod+alt+2");
    expect(APP_CHORD_DEFAULTS["pane.pr"]).toBe("mod+alt+3");
    expect(APP_CHORD_DEFAULTS["pane.card"]).toBe("mod+alt+4");
  });

  test("they carry Alt, because a live shell is crowded", () => {
    /* Ctrl+Shift+letter is "select all" in half the terminals and a tmux prefix
       in some configurations; an Alt chord arrives as an escape sequence
       nothing common binds. Same reason the bench uses one. */
    for (const id of ["pane.git", "pane.diff", "pane.pr", "pane.card"] as const) {
      expect(APP_CHORD_DEFAULTS[id]).toContain("alt");
      expect(APP_CHORD_DEFAULTS[id]).not.toBe(APP_CHORD_DEFAULTS["bench.toggle"]);
    }
  });

  test("and it is not a tmux binding", () => {
    // Nothing is written into the engine's config for this: the app answers the
    // key before the terminal ever sees it.
    const conf = readFileSync(new URL("../../server/src/tmuxconf.ts", import.meta.url), "utf8");
    expect(conf).not.toContain("@agx-open");
    expect(conf).not.toMatch(/bind-key\s+[gdpc]\b/);
  });
});

describe("what it acts on", () => {
  test("the card resolves the way the chip beside it does", () => {
    // One answer about where a card lives, not two that can disagree.
    const term = read("components/TerminalPanel.tsx");
    expect(term).toContain("cardRef({ headRefName: chipWt.branch })");
    expect(term).toContain("chipAction(ref, cuSetup)");
  });

  test("the focused pane, read when the key is pressed", () => {
    /* Not closed over: this hook is set once on mount and the pull request
       behind the focused pane changes several times a minute. */
    const term = read("components/TerminalPanel.tsx");
    expect(term).toContain("export function openFocusedPaneDoor(which: PaneDoor): boolean");
    expect(term).toContain("const at = prRef.current;");
    expect(term).toContain("useEffect(() => { prRef.current = chipPr; }, [chipPr]);");
  });

  test("and the key falls through when there is nothing to open", () => {
    // No terminal on screen, or a branch with no pull request: the chord is not
    // eaten by a view that cannot answer it.
    const app = read("App.tsx");
    expect(app).toContain("if (openFocusedPaneDoor(action.slice(5) as PaneDoor)) { e.preventDefault(); return; }");
  });
});

/*
 * And the digit is the key you pressed, not what the layout made of it.
 *
 * "Ctrl alt 4 does not open the card." Ctrl+Alt is AltGr on a Spanish keyboard, and
 * AltGr+1..4 there are `|`, `@`, `#` and `~` — so the chord arrived as
 * `mod+alt+~` and matched nothing. `code` is the physical key and says `Digit4`
 * on every layout.
 */
describe("a digit on any keyboard", () => {
  const ev = (o: Partial<{ key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) =>
    ({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

  test("AltGr+4 on a Spanish layout is still the 4 on the keycap", () => {
    expect(chordFromEvent(ev({ key: "~", code: "Digit4", ctrlKey: true, altKey: true }))).toBe("mod+alt+4");
  });

  test("and so is the keypad", () => {
    expect(chordFromEvent(ev({ key: "4", code: "Numpad4", ctrlKey: true, altKey: true }))).toBe("mod+alt+4");
  });

  test("a letter is left to its own layout", () => {
    /* `code` would bind a Dvorak user to QWERTY positions: a letter's `key` is
       already the letter they are looking at. */
    expect(chordFromEvent(ev({ key: "r", code: "KeyP", ctrlKey: true, altKey: true }))).toBe("mod+alt+r");
  });
});

/*
 * Ctrl+Shift+C copies the branch — when there is nothing selected.
 *
 * "In the pane, pressing shift + ctrl + c should copy / trigger the worktree
 * copy, this branch copy": the same thing the ⧉ beside the branch does, without
 * reaching for the block.
 *
 * A SELECTION still wins. Ctrl+Shift+C is every terminal's copy, and taking it
 * from somebody who has just dragged over an error message would be a bad trade
 * for a convenience. With nothing selected it does nothing today, which is the
 * gap this fills.
 */
describe("copying the branch from the shell", () => {
  const term = read("components/TerminalPanel.tsx");

  test("a selection keeps the chord", () => {
    expect(term).toContain("!term.hasSelection() && copyPaneBranch()");
  });

  test("and it copies the pane's own branch, not the panel's checkout", () => {
    const fn = term.slice(term.indexOf("copyPaneBranch = () => {"));
    expect(fn.slice(0, 600)).toContain("const wt = wtRef.current;");
    expect(fn.slice(0, 600)).toContain("wt.worktreeOf ? wt.branch : wt.name");
  });

  test("it says nothing, because there is nowhere to say it", () => {
    /* No toast over a terminal in this app, and a line written into the shell
       is a line in somebody's command history. The clipboard is the feedback. */
    const fn = term.slice(term.indexOf("copyPaneBranch = () => {"));
    expect(fn.slice(0, 600)).not.toContain("flash(");
  });
});
