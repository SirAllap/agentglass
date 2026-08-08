/*
 * The phone's field IS the pane's input line — these are the two pieces that
 * make that true, and both fail silently when they are wrong.
 *
 * The edit sends keystrokes to somebody's real shell. Getting the erase count
 * wrong by one does not throw: it eats a character of a command that then runs.
 *
 * The prompt reader decides whether the field is live at all, and the way it
 * fails is by finding a "prompt" in a line of build output and offering it to
 * be pressed Enter on. So it is checked against real captured lines, including
 * ones it must REFUSE.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editFor } from "../src/terminal/mirror.ts";
import { terminalDocument } from "../src/terminal/terminal-html.ts";
import { C } from "../src/theme.ts";

const DEL = "\x7f";

describe("the keystrokes that turn one line into another", () => {
  test("typing at the end sends only what is new", () => {
    expect(editFor("hola", "hola ")).toBe(" ");
    expect(editFor("hola como", "hola como vas")).toBe(" vas");
    // The case this exists for: picking the phone up mid-sentence.
    expect(editFor("hola como vas ", "hola como vas bien")).toBe("bien");
  });

  test("the phone's backspace is a backspace on the pane", () => {
    expect(editFor("hola", "hol")).toBe(DEL);
    expect(editFor("hola", "ho")).toBe(DEL + DEL);
    // Clearing the field clears the line, and no further: erasing past the
    // start would eat the prompt on a shell that lets it.
    expect(editFor("hola", "")).toBe(DEL.repeat(4));
  });

  test("an edit in the middle erases back to it and retypes", () => {
    // "gato" → "gordo": they agree on "g", so three back and "ordo" forward.
    expect(editFor("gato", "gordo")).toBe(DEL.repeat(3) + "ordo");
    // And nothing at all when nothing changed — an echo from the pane arriving
    // while the field holds the same text must not type into it.
    expect(editFor("igual", "igual")).toBe("");
  });

  test("a character outside the basic plane is one erase, not two", () => {
    // "🙂" is two UTF-16 units and one glyph on the terminal. Counting units
    // would send two DELs and eat the character before it.
    expect(editFor("ok🙂", "ok")).toBe(DEL);
    expect(editFor("🙂🙂", "🙂")).toBe(DEL);
    // And a prefix mismatch must never split one in half.
    expect(editFor("🙂a", "🙂b")).toBe(DEL + "b");
  });

  test("an empty line to a whole command is just the command", () => {
    expect(editFor("", "npm run build")).toBe("npm run build");
  });
});

describe("reading the typed line off the screen", () => {
  /** The regex the page carries, pulled out of the document it builds. Read
   *  from the source rather than copied, so this cannot pass against a rule the
   *  page no longer uses. */
  const prompt = (): RegExp => {
    const doc = terminalDocument({ palette: C, columns: 80 });
    const found = /var PROMPT = \/(.*)\/;/.exec(doc);
    expect(found).not.toBeNull();
    return new RegExp(found![1]!);
  };
  const typedOn = (line: string): string | null => {
    const hit = prompt().exec(line);
    return hit ? line.slice(hit[0].length) : null;
  };

  test("the page's regexes survived being written inside a template literal", () => {
    /*
     * This whole document is one template literal, and `\s` in one is not an
     * escape — it collapses to a plain "s". Both regexes in it have to be
     * written `\\s`, and the trim was not: it shipped as /s+$/ and quietly
     * trimmed the letter s off the end of whatever was typed.
     *
     * It took a real browser to notice, and this file runs everywhere that one
     * does not. Asserted on the emitted text rather than on behaviour for
     * exactly that reason — the same trap already cost this file's neighbour a
     * closing backtick once.
     */
    const doc = terminalDocument({ palette: C, columns: 80 });
    // Anchored on the CALL and not on the pattern alone: the page carries a
    // comment naming the broken form, and the first version of this check found
    // its own explanation and failed.
    expect(doc).toContain("replace(/\\s+$/");
    expect(doc).not.toContain("replace(/s+$/");
    expect(doc).toContain("var PROMPT = /^[\\s"); // likewise doubled
    expect(doc).toContain("\\u276f");
  });

  test("an agent's prompt, captured from a real pane", () => {
    // Verbatim from `capture-pane` on a running agent, U+276F and a space.
    expect(typedOn("❯ hola como vas bien")).toBe("hola como vas bien");
    expect(typedOn("❯ ")).toBe("");
    expect(typedOn("❯ npm run build")).toBe("npm run build");
  });

  test("a prompt drawn inside a box", () => {
    // An agent draws its input in a border, so the row starts with the border.
    expect(typedOn("  │ > dentro de una caja")).toBe("dentro de una caja");
    expect(typedOn("│ $ ls -la")).toBe("ls -la");
  });

  test("and it refuses a line it cannot read", () => {
    // The important half. Offering one of these as something to press Enter on
    // is worse than offering nothing, so anything without a marker is null —
    // which the screen treats as "leave the field alone", never as "empty".
    expect(typedOn("Ran 3 shell commands")).toBeNull();
    expect(typedOn("  Applying events.0027_add_receipt_event... OK")).toBeNull();
    expect(typedOn("")).toBeNull();
    expect(typedOn("    ")).toBeNull();
  });

  test("the prompt is taken at index 0, never searched for backwards", () => {
    /*
     * Structural, because the behaviour needs a browser and this file is what
     * runs where there is none — and because the failure is silent.
     *
     * The reader kept the LAST marker on the row, and the marker class is
     * ordinary shell syntax: measured in a real engine, `echo $HOME` read back
     * as "HOME", `cat a > b` as "b", `git log --format=%h` as "h",
     * `git commit -m fix#12` as "12" and `make 2>&1` as "&1". The field sends
     * the difference between what it believes and what it holds, so believing
     * "log.txt" of a pane holding "make build > log.txt" meant a clear sent
     * seven DELs and the next command ran with a file called ls as its target.
     *
     * The neighbour on a split was the only thing the backwards search was for,
     * and the border cut handles that exactly. The five live cases are in
     * pane-line.test.ts.
     */
    const doc = terminalDocument({ palette: C, columns: 80 });
    expect(doc).toContain("var match = PROMPT.exec(raw);");
    expect(doc).not.toContain("for (var i = raw.length;");
  });

  test("the read is bounded on the left by the pane border", () => {
    // Only the box-drawing verticals, and never the ASCII pipe: a shell line
    // being typed is full of pipes, and cutting at the last one would hand back
    // the tail of somebody's pipeline as the whole of it.
    const doc = terminalDocument({ palette: C, columns: 80 });
    expect(doc).toContain("0x2502");
    expect(doc).not.toContain("code === 0x7c");
  });
});

/*
 * Who owns the line while it is being typed.
 *
 * The screen's half of the mirror, and it cannot be reached from here: it is a
 * ref inside a component that needs a device and a live pane. So it is asserted
 * against the source, the way the takeover already is — because this is a rule
 * that is correct once and silently wrong later, and it is the rule the 60-column
 * report turned out to be about.
 */
describe("the field's claim on the line", () => {
  const screen = readFileSync(join(import.meta.dir, "..", "app", "(tabs)", "terminal.tsx"), "utf8");

  test("a screen read cannot replace a line somebody is typing", () => {
    /*
     * The whole bug, in one guard. A 60-column phone on a four-pane window gives
     * panes 23 columns wide, so a typed line wraps inside its pane after twenty
     * characters — and tmux redraws that wrap by moving the cursor, leaving no
     * prompt marker on the cursor's row. The page then correctly answers "I
     * cannot tell", and adopting that answer mid-line set `shadow` to null,
     * which made `typed` take its early return and swallow every further
     * keystroke in silence.
     *
     * Measured on a 30-column pane with 60 characters typed into it: the pane
     * held the first 32 while typing, and Send — seeing a null shadow and
     * believing nothing had been sent — sent the whole line again on top of
     * them, so the shell ran those 32 characters twice.
     */
    expect(screen).toContain("if (claimed.current) return;");
  });

  test("and the claim is given back at every point the line ends", () => {
    // Sending it, putting the phone down, emptying the field, and any key from
    // the bar — which is an instruction to the pane that this field did not
    // make, and the ones people press change the line under it.
    expect(screen).toContain("claimed.current = text.length > 0;");
    expect(screen).toContain("onBlur={() => { claimed.current = false; forgetKeys(); }}");
    const onKey = screen.slice(screen.indexOf("const onKey ="), screen.indexOf("const onState ="));
    expect(onKey).toContain("claimed.current = false;");
    // Both arms of submit: the one that only sends a carriage return, and the
    // one that sends the whole line.
    const submit = screen.slice(screen.indexOf("const submit ="), screen.indexOf("const typed ="));
    expect(submit.match(/claimed\.current = false;/g)).toHaveLength(2);
  });
});

/*
 * `keys` mode, where the field is a conduit and not a line.
 *
 * The defect: it sent the WHOLE field on every change and kept the field empty
 * by controlling its value to a constant "". Emptying it is a render, and a
 * render does not keep up with a thumb — so the next character arrived while
 * the input still held the last one, the change event carried both, and the
 * whole buffer went down the socket again. Measured on the emulator against a
 * pane running `cat -v`, typing `hello` at ordinary speed: the pane received
 * `hhehelhello`. Typed with 1.2s between characters it was correct, which is
 * the whole tell.
 *
 * The events below are the ones a lagging clear actually delivers. What is
 * asserted is the pane, not the field: this is the only place the bug was ever
 * visible.
 */
describe("what a burst of typing puts on the pane", () => {
  /** The pane, as a field reporting `events` in order would leave it. */
  const paneAfter = (events: string[]): string => {
    let sent = "";
    let pane = "";
    for (const now of events) {
      // Exactly what the screen does in `keys` — see `typed` in terminal.tsx.
      const keys = editFor(sent, now);
      sent = now;
      // A terminal's DEL erases the character before it, which is what the tty
      // does with it in canonical mode and what the emulator measurement saw.
      for (const ch of keys) pane = ch === "\x7f" ? pane.slice(0, -1) : pane + ch;
    }
    return pane;
  };

  test("a field whose clear has not landed yet sends each character once", () => {
    expect(paneAfter(["h", "he", "hel", "hell", "hello"])).toBe("hello");
    expect(paneAfter(["X", "XY", "XYZ"])).toBe("XYZ");
  });

  test("which is why the field is never emptied while somebody is typing", () => {
    /*
     * The hazard the shape is chosen against, written down as an assertion
     * rather than as a hope.
     *
     * If the field WERE cleared between two keystrokes, the events would arrive
     * as five separate characters — and the difference from `h` to `e` is a DEL
     * and an `e`, so the pane loses a character it was never asked to lose. The
     * old code could not hit this because it sent the whole field; the new code
     * cannot hit it because nothing clears the field while a thumb is on it (see
     * `keyed` in terminal.tsx: blur and the mode switch, and deliberately not
     * Enter).
     */
    expect(paneAfter(["h", "e", "l", "l", "o"])).toBe("o");
    expect(editFor("h", "e")).toBe("\x7fe");
  });

  test("the screen's `keys` field really is a buffer, not a constant empty", () => {
    // The two lines that would put the whole defect back: a value pinned to ""
    // and a send of the field rather than of the difference.
    const screen = readFileSync(join(import.meta.dir, "..", "app", "(tabs)", "terminal.tsx"), "utf8");
    expect(screen).toContain("value={raw ? keyed : draft}");
    expect(screen).toContain("const keys = editFor(keyedSent.current, text);");
    expect(screen).not.toContain("value={raw ? \"\" : draft}");
  });

  test("a backspace is a DEL and nothing else", () => {
    // The key that never reached the pane at all: `onKeyPress` was its only
    // route and Android does not fire it for Backspace on an empty soft-keyboard
    // field — measured, `xyz` on the pane was still `xyz` after two presses. A
    // field that keeps what was typed reports it as an ordinary change.
    expect(paneAfter(["hello", "hell", "hel"])).toBe("hel");
    // And it must not retype the tail it kept.
    expect(editFor("hello", "hell")).toBe("\x7f");
  });
});
