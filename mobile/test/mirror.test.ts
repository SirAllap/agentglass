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
    // The sentence that EXPLAINS all this has to survive the trip too, and it
    // did not: written with one backslash it reached the page with the
    // backslash eaten — the warning swallowed by the thing it warns about.
    // Harmless, and the only escape in that file that really collapsed, which
    // is why it is worth one line to keep it from coming back.
    //
    // Positive only, for the reason three lines up: the page's prose is ABOUT
    // this bug, so a check for the broken spelling finds the explanation. That
    // trap has now caught this test twice.
    expect(doc).toContain("lone \\s in one is not an escape");
  });

  test("what the page ships is a character class, not the letter s", () => {
    /*
     * The check above reads the page's TEXT, which is the right way round for a
     * file no runtime here ever executes. This one takes the two regexes back
     * out of it and runs them, because a static scanner reading this source
     * sees `\\s` and can conclude the page ships a plain "s" — and the answer
     * to that is not an argument, it is the behaviour.
     */
    const doc = terminalDocument({ palette: C, columns: 80 });
    const trim = new RegExp(/replace\(\/(.*?)\/, ''\)/.exec(
      doc.slice(doc.indexOf("raw.slice(match[0].length)")))![1]!);
    // The bug this replaced: /s+$/ turns "git status" into "git statu".
    expect("git status".replace(trim, "")).toBe("git status");
    expect("git status   ".replace(trim, "")).toBe("git status");
    // And the prompt's own class eats whitespace rather than the letter.
    expect(prompt().test("  > ")).toBe(true);
    expect(typedOn("ssss > x")).toBeNull();
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
    // All three arms of the send: the exact mirror, which only needs a carriage
    // return; the line the field READ off a wrapped box, which also only needs
    // one; and the composer, which sends the whole thing. `submit` was renamed
    // `commit` when it stopped reading `draft` and started taking the text —
    // see the note there on the return key arriving inside a change event.
    const commit = screen.slice(screen.indexOf("const commit ="), screen.indexOf("function typed("));
    expect(commit.match(/claimed\.current = false;/g)).toHaveLength(3);
  });
});

/*
 * The line an agent wrapped, and the two things that must not happen to it.
 *
 * Both were measured on the emulator against a real Claude Code pane, and they
 * are the same bug seen from two ends. A line longer than the pane is drawn on
 * rows the PROGRAM lays out — indented under the prompt, no marker of their
 * own, not flagged as wrapped in the buffer — so the cursor's row has nothing
 * for `PROMPT` to find and the read answered null:
 *
 *   1. the phone's field went EMPTY while the pane held the whole line, which
 *      is "one shows the text and the other does not";
 *   2. and the field, now a composer, sent its contents on top of what was
 *      already there. Captured: `esto es una linea larga escrita en el
 *      ordenador para ver si el movil la` typed at the computer plus `hola2`
 *      typed on the phone ran as one prompt, concatenated.
 */
describe("a line the field could read but cannot edit", () => {
  const screen = readFileSync(join(import.meta.dir, "..", "app", "(tabs)", "terminal.tsx"), "utf8");
  const page = readFileSync(join(import.meta.dir, "..", "src", "terminal", "terminal-html.ts"), "utf8");

  test("the page rejoins the rows rather than answering nothing", () => {
    expect(page).toContain("var boxedLine = function (end)");
    expect(page).toContain("if (!match) return boxedLine(end);");
    // And says which kind of answer it is, every time, so the screen never has
    // to infer it from the text.
    expect(page).toContain("exact: true");
    expect(page).toContain("exact: false");
  });

  test("it stops at the top of the box instead of walking the transcript", () => {
    // A marker above the rule belongs to a turn that has already been sent, and
    // joining one into the field would put an old prompt in front of the live
    // one. The rule is drawn on the screen, so this is a boundary and not a
    // guess.
    expect(page).toContain("if (RULE.test(text.trim())) return null;");
    expect(page).toContain("for (var up = 1; up <= BOX_ROWS; up++)");
  });

  test("an inexact read is held as the pane's line, never as the field's", () => {
    expect(screen).toContain("shadow.current = exact ? text : null;");
    expect(screen).toContain("onPane.current = exact ? null : text;");
  });

  test("and Send then sends a carriage return, not the line again", () => {
    const commit = screen.slice(screen.indexOf("const commit ="), screen.indexOf("function typed("));
    const from = commit.indexOf("if (onPane.current !== null)");
    const held = commit.slice(from, commit.indexOf("if (!text) return;", from));
    expect(held).toContain('terminal.current?.send("\\r")');
    // The one line that would put the corruption back.
    expect(held).not.toContain("${text");
  });

  test("typing onto it is allowed only where no length has to be believed", () => {
    /*
     * An append needs no arithmetic: what to send is the part of the field past
     * the text that was shown. Everything else does — a DEL count is computed
     * against a length, and a rejoined line's length is off by one per break
     * that was a word wrap, because the space at the break is never drawn.
     */
    expect(screen).toContain("if (!text.startsWith(onPane.current)) return;");
    expect(screen).toContain("shadow.current = onPane.current;");
  });
});

/*
 * The return key, and the newline that is not one.
 *
 * Measured against a real Claude Code pane: a bare LF does NOT submit — it puts
 * a second row in the input box, and the cursor then sits on a row with no
 * prompt marker, which is the state that turns the mirror off. So a keystroke
 * that arrives as text rather than as an editor action both fails to send and
 * breaks the field that sent it, which is exactly "I press enter, nothing
 * happens, and it works the second time".
 */
describe("what the return key becomes", () => {
  const screen = readFileSync(join(import.meta.dir, "..", "app", "(tabs)", "terminal.tsx"), "utf8");

  test("a trailing newline in the field is a send, not a character", () => {
    expect(screen).toContain('if (text.endsWith("\\n"))');
    expect(screen).toContain('const body = text.replace(/\\n+$/, "");');
  });

  test("and no newline ever reaches the pane as one", () => {
    expect(screen).toContain('const forPane = (keys: string): string => keys.replace(/\\n/g, "\\r");');
    // Both writers of pane bytes from the field go through it.
    const typed = screen.slice(screen.indexOf("function typedBody("));
    expect(typed.match(/terminal\.current\?\.send\(forPane\(keys\)\)/g)).toHaveLength(2);
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
