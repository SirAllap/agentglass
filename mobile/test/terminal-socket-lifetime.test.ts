/*
 * The socket's lifetime belongs to the pane, and to nothing else.
 *
 * What happened the first time this ran on a phone: the effect that opens
 * `/terminal/pty` listed its callback props in its dependency array. The screen
 * passed an inline arrow — the ordinary way to write a callback — which is a
 * new function on every render, so the effect closed the socket and opened
 * another; that one called `onState`, which set state, which re-rendered, which
 * made another arrow. It never stopped, and every turn of it spawned a fresh
 * grouped tmux session on the machine.
 *
 * It cannot be caught by a type-check, a bundle, or any assertion about output:
 * everything is correct, once. So the rule is asserted against the source,
 * which is where the rule lives.
 *
 * The fix is refs — the effect reaches the CURRENT callback while depending on
 * none of them — and that is what these two tests hold in place.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "src", "terminal", "TerminalView.tsx"), "utf8");

/** The dependency array of the effect that constructs the WebSocket. */
function socketEffectDeps(): string[] {
  // Anchored on the construction rather than on the path: the path is also in
  // this file's header comment, and the first version of this test read the
  // dependency array of an unrelated `useCallback` because of it — passing the
  // assertions that mattered for the wrong reason.
  const start = source.indexOf("new Ctor(");
  expect(start, "the socket effect moved — this test is looking at the wrong code").toBeGreaterThan(0);
  const close = source.indexOf("}, [", start);
  expect(close, "no dependency array after the socket effect").toBeGreaterThan(0);
  const end = source.indexOf("]", close);
  return source
    .slice(close + 4, end)
    .split(",")
    .map((d) => d.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean);
}

/**
 * Every callback the component takes, read off the `Props` interface.
 *
 * Derived rather than listed, because the failure this file exists for is a
 * callback that somebody added later and did not think about. A hand-written
 * list is only ever as current as the last person to remember it — which is
 * the same person who would have remembered the rule.
 */
function callbackProps(): string[] {
  const block = /interface Props \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/^\s{2}(on[A-Z]\w*)\??:/gm)].map((m) => m[1]!);
}

describe("what re-opens the terminal socket", () => {
  test("only things that identify the connection", () => {
    const deps = socketEffectDeps();
    // A prop whose identity changes per render must never be in here. These are
    // the ones that did.
    // Every one of them, found from the props rather than listed here: a
    // callback added later is exactly the one nobody thinks to add to a list.
    for (const name of callbackProps()) expect(deps).not.toContain(name);
    // The ones that did it, kept by name so the check cannot quietly pass by
    // finding no callbacks at all.
    expect(callbackProps()).toContain("onState");
    expect(callbackProps()).toContain("onTmux");
    // And the ones that must be, or a tab switch would keep the old pane's
    // socket while showing the new pane's name.
    expect(deps).toContain("pane");
    expect(deps).toContain("host");
  });

  test("the callbacks are reached through a ref", () => {
    // The mechanism, not just the absence: without this the next person
    // "fixes" the lint warning by putting the callbacks back.
    //
    // Matched on the ref existing and holding EVERY callback prop, rather than
    // on one exact tuple — pinning the tuple made this fail the day an
    // `onLine` was added, which is a passing design change reported as a
    // regression, and the fastest way to teach somebody to delete the check.
    const held = /const handlers = useRef\(\{([^}]*)\}\);/.exec(source)?.[1] ?? "";
    const assigned = /handlers\.current = \{([^}]*)\};/.exec(source)?.[1] ?? "";
    for (const name of callbackProps()) {
      expect(held.split(",").map((s) => s.trim())).toContain(name);
      expect(assigned.split(",").map((s) => s.trim())).toContain(name);
    }
    expect(source).toContain("handlers.current.onState");
    // No direct call left behind — one of those is enough to reintroduce the
    // dependency the day somebody re-runs the linter.
    const direct = source
      .split("\n")
      .filter((line) => /(?<!handlers\.current\.)\bonState\(/.test(line))
      .filter((line) => !line.includes("onState:") && !line.trimStart().startsWith("*"));
    expect(direct, `onState is called directly here:\n${direct.join("\n")}`).toEqual([]);
  });
});
