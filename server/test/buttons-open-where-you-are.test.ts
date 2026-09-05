/**
 * A window a person asked for opens in the session they are looking at.
 *
 * Said four times before it was written down, and the last time as plainly as
 * it can be said: "when I click resolve a conflict, or when I click any button
 * that says hand to the terminal, it has to open in the session I have open,
 * it must not create a new session".
 *
 * `engineWindowRunning` derived the session from the WORKTREE — one tmux
 * session per checkout — so a conflict in another checkout opened a window in
 * a session that was never on screen. The strip only shows the session its own
 * client is attached to, so the window was invisible; and the fix that switches
 * the client onto it took four windows of somebody's own work off their screen
 * instead. There was never a technical reason for the split: a window lives in
 * one session and starts its shell wherever `-c` says.
 *
 * ONE EXCEPTION, and it is deliberate: the clone's own runs. Those it starts by
 * itself, and they belong in a session of their own rather than filling
 * somebody's strip with windows they did not open.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

/** Every call to `engineWindowRunning`, with the file it is in. */
function callSites(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const f of ["terminal.ts", "index.ts", "runs.ts", "understudy-pane.ts"]) {
    const src = read(f);
    for (let at = src.indexOf("engineWindowRunning("); at > -1; at = src.indexOf("engineWindowRunning(", at + 1)) {
      if (src.slice(Math.max(0, at - 40), at).includes("export async function")) continue;
      /* To the call's own closing paren, by balancing — a fixed slice stops
         mid-argument on the ones that wrap over several lines. */
      let depth = 0, end = at;
      for (let i = src.indexOf("(", at); i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      out.push({ file: f, text: src.slice(at, end) });
    }
  }
  return out;
}

/** A call's own arguments, split on the commas that are not inside brackets. */
function topLevelArgs(call: string): string[] {
  const inner = call.slice(call.indexOf("(") + 1, call.lastIndexOf(")"));
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) { out.push(inner.slice(start, i)); start = i + 1; }
  }
  out.push(inner.slice(start));
  return out.map((a) => a.trim()).filter(Boolean);
}

describe("who gets a session of their own", () => {
  test("every button a person presses opens in the session they are on", () => {
    /* The clone's own paths, by file and by the window name it uses — not by
       a word appearing anywhere in the call, which put `runs.ts` on the wrong
       side of the line. */
    const isClone = (c: { file: string; text: string }) =>
      c.file === "runs.ts" || c.file === "understudy-pane.ts" || /understudy:/.test(c.text);
    const theirs = callSites().filter((c) => !isClone(c));
    expect(theirs.length, "the button call sites moved").toBeGreaterThanOrEqual(3);
    for (const c of theirs) {
      /* The SIXTH argument is the session, and what it is called at the call
         site is nobody's business — an earlier version of this pinned two
         variable names and went red on a third that was perfectly correct. */
      expect(topLevelArgs(c.text).length, `${c.file}: no session passed — this window lands where nobody will find it`)
        .toBeGreaterThanOrEqual(6);
    }
  });

  test("and the clone's own runs still get one to themselves", () => {
    /* The exception, and the only one: these are started by the machine, not
       by a press, and putting them on the strip fills it with windows nobody
       opened. */
    const clone = callSites().filter((c) =>
      c.file === "runs.ts" || c.file === "understudy-pane.ts" || /understudy:/.test(c.text));
    expect(clone.length, "the clone opens its runs through this too").toBeGreaterThanOrEqual(1);
    for (const c of clone) {
      expect(topLevelArgs(c.text).length, "a clone run must not land in somebody's working session")
        .toBeLessThan(6);
    }
  });

  test("the parameter is optional, so the clone's path needs no change", () => {
    const src = read("tmuxpane.ts");
    expect(src).toContain("into?: string");
    // …and an invalid name falls back rather than refusing to open anything.
    expect(src).toContain("namedSession || engineSessionName(root)");
  });
});

describe("the session name that gets obeyed", () => {
  const src = readFileSync(new URL("../src/tmuxpane.ts", import.meta.url), "utf8");

  test("stricter than validSessionName, because this is new surface", () => {
    /* Found by RUNNING it against a real tmux, not by reading: passing
       "not valid; rm -rf" as the session created a session by that name.
       `validSessionName` allows spaces and punctuation — correct for names
       this app already made and must keep addressing, wrong for a parameter
       that reaches `new-window -t`. */
    expect(src).toContain("/^[A-Za-z0-9_-]{1,64}$/.test(into)");
  });

  test("and a dot is excluded on purpose", () => {
    /* tmux SILENTLY rewrites a dot to an underscore when it makes the session,
       so `-t a.b` then addresses one that does not exist and the window is
       lost. Measured; no session this app makes contains one. */
    expect(src, "a dot in the pattern loses the window without an error").not.toContain("[A-Za-z0-9._-]");
  });

  test("an unusable name falls back rather than refusing to open", () => {
    expect(src).toContain("namedSession || engineSessionName(root)");
  });
});

/*
 * AND A CLONE'S WINDOW DOES NOT TAKE THE SCREEN AT ALL.
 *
 * `new-window` without `-d` makes the new window the session's current one, and
 * every client attached to that session redraws onto it — the app's Terminal
 * panel and any real `tmux -L agentglass attach` alike. That is right when a
 * person pressed a button and is waiting to see what happened.
 *
 * It is wrong for the clone. It opens one window per task in the session of the
 * PROJECT, which is the very session a terminal tab on that checkout is
 * attached to, so a shift of ten tasks is ten yanks mid-typing and only the
 * first can be traced to anything a person did. The same harm is written down
 * two files over in as many words: "took four windows of somebody's own work
 * off their screen without warning".
 */
test("selecting the new window is opt-in, and the clone does not opt in", () => {
  const pane = readFileSync(new URL("../src/tmuxpane.ts", import.meta.url), "utf8");
  const at = pane.indexOf("export async function engineWindowRunning");
  expect(at, "engineWindowRunning moved").toBeGreaterThan(-1);
  const body = pane.slice(at, pane.indexOf("\n}", pane.indexOf('"new-window"', at)));
  /* `-d` unless the caller asked to be taken there. */
  expect(body).toContain('select ? [] : ["-d"]');

  /* The clone's two openers take the default. */
  for (const f of ["../src/understudy-pane.ts", "../src/index.ts", "../src/runs.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of src.matchAll(/engineWindowRunning\(([^;]*?)\)\s*[;,)]/gs)) {
      const args = m[1]!;
      expect(args.trimEnd().endsWith("true"), `${f}: a clone window must not select — ${args.slice(0, 60)}`).toBe(false);
    }
  }
});

test("and the buttons a person presses DO opt in", () => {
  /* The other half of the same rule: a window opened because somebody pressed
     something is a window they are waiting to see. */
  const term = readFileSync(new URL("../src/terminal.ts", import.meta.url), "utf8");
  const calls = [...term.matchAll(/engineWindowRunning\(([^;]*?)\)\s*[;.]/gs)];
  expect(calls.length, "the terminal's openers moved").toBeGreaterThan(3);
  for (const m of calls) {
    expect(m[1]!.trimEnd().endsWith("true"), `a person's window must select — ${m[1]!.slice(0, 50)}`).toBe(true);
  }
});
