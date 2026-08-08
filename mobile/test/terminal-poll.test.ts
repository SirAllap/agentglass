/*
 * The strip keeps up with the computer on its own, and costs nothing when the
 * computer stands still.
 *
 * Reported from a phone: "cuando tengo la app de movil abierta y en el pc en
 * una tab que solo tiene un pane meto uno mas… tengo que refresh para que se
 * haga, no es un auto sync como tiene que ser." Measured, and he was exactly
 * right: `load()` ran once on mount and after that only from the two refresh
 * buttons. The desk does not have the problem because the server sweeps tmux
 * twice a second and pushes it a `t:"tmux"` frame; the phone's socket carries
 * `events`, `notify` and pty bytes and nothing that says the panes moved.
 *
 * The fix is a poll while the screen is focused, and a poll has one dangerous
 * half: the answer is a fresh array every couple of seconds, so adopting it
 * unconditionally repaints the strip for ever — and a strip that repaints under
 * your thumb is a strip that eats the tap. Both halves are held here: the
 * comparison in `readStrip`, which is ordinary code and testable as such, and
 * the wiring in the screen, which is not — there is no renderer in this
 * project, and the rule "nothing writes state before the guard" is a fact about
 * the source, so that is where it is asserted. Same technique, and the same
 * reason, as `terminal-socket-lifetime.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readStrip } from "../src/terminal/tabs.ts";
import type { AgentPane, PanesResponse } from "../../shared/types.ts";

// The wire's own row. It used to be a copy declared inside tabs.ts, which is
// how `attached` — the field the filter below turns on — could be renamed on
// the server without a single test here going red.
const pane = (over: Partial<AgentPane>): AgentPane => ({
  session: "work", sessionId: "$1", windowId: "@1", windowIndex: "1",
  windowName: "agents", paneId: "%1", path: "/home/x/code/work", agentCwds: [],
  attached: true, agentSession: null, ...over,
});

/** The machine as it was before he split anything: one window, one pane. */
const ONE = { canAttach: true, panes: [pane({})] };

/** `readStrip` from nothing, which is what a first read is. */
const first = (answer: Partial<PanesResponse>): string => {
  const read = readStrip(null, answer);
  if (!read.changed) throw new Error("a first read always changes something");
  return read.shape;
};

describe("a tick that changes nothing", () => {
  test("says so, and carries no tabs to adopt", () => {
    /*
     * The assertion the whole poll rests on. `changed: false` has no `tabs`
     * field — deliberately, in the type — so there is nothing for the screen to
     * hand `setStrip`, which is the one setter that cannot bail out on its own:
     * a fresh array is never `Object.is` the last one, so React commits it and
     * the strip repaints. Every other setter on that path (`setStale`,
     * `setError`, and the two functional ones) already bails when the value
     * matches.
     */
    const read = readStrip(first(ONE), ONE);
    expect(read.changed).toBe(false);
    expect(read).not.toHaveProperty("tabs");
  });

  test("even when the answer is a different object every time", () => {
    // Which it is: this arrives from `JSON.parse` on a fresh response body, so
    // identity is never a shortcut here.
    const shape = first({ canAttach: true, panes: [pane({}), pane({ paneId: "%2" })] });
    const again = readStrip(shape, { canAttach: true, panes: [pane({}), pane({ paneId: "%2" })] });
    expect(again.changed).toBe(false);
  });

  test("even when a pane moved somewhere the strip does not show", () => {
    /*
     * `pane_current_path` moves with every `cd` and the strip shows nothing of
     * it but the last segment; the session and window IDS are on the wire and
     * are drawn nowhere at all. Repainting on those would be repainting on
     * somebody typing `cd ..` at the desk.
     */
    const again = readStrip(first(ONE), {
      canAttach: true,
      panes: [pane({ path: "/somewhere/else/work", sessionId: "$7", windowId: "@9" })],
    });
    expect(again.changed).toBe(false);
  });

  test("even when an agent's cwd list churns under a pane", () => {
    // The tab carries "there is an agent here" and not how many: a second
    // process appearing under the same pane is not a strip that moved.
    const shape = first({ canAttach: true, panes: [pane({ agentCwds: ["/home/x/code/work"] })] });
    const again = readStrip(shape, {
      canAttach: true,
      panes: [pane({ agentCwds: ["/home/x/code/work", "/home/x/code/work/sub"] })],
    });
    expect(again.changed).toBe(false);
  });

  test("even when this phone's own grouped session appears beside it", () => {
    /*
     * Opening a tab makes an `agx-phone-…` session holding the SAME windows, so
     * it comes back in the next `list-panes` — every time. Left in the shape,
     * attaching to a pane would repaint the strip a beat later, which is the
     * exact moment the thumb is still on the tab it just pressed.
     */
    const again = readStrip(first(ONE), {
      canAttach: true,
      panes: [pane({}), pane({ session: "agx-phone-1-abc123", sessionId: "$9", paneId: "%9" })],
    });
    expect(again.changed).toBe(false);
  });
});

describe("a tick that changes something", () => {
  test("a pane split at the computer arrives without touching the phone", () => {
    // The bug, in one assertion: one pane became two and the phone must notice.
    const read = readStrip(first(ONE), { canAttach: true, panes: [pane({}), pane({ paneId: "%2" })] });
    expect(read.changed).toBe(true);
    if (!read.changed) return;
    expect(read.tabs.map((t) => t.label)).toEqual(["1 agents·p1", "1 agents·p2"]);
  });

  test("and so does a new window", () => {
    const read = readStrip(first(ONE), {
      canAttach: true,
      panes: [pane({}), pane({ windowId: "@2", windowIndex: "2", windowName: "build", paneId: "%2" })],
    });
    expect(read.changed).toBe(true);
    if (!read.changed) return;
    expect(read.tabs.map((t) => t.label)).toEqual(["1 agents", "2 build"]);
  });

  test("a window renamed at the desk", () => {
    // Same panes, same ids, a different strip to read.
    expect(readStrip(first(ONE), { canAttach: true, panes: [pane({ windowName: "renamed" })] }).changed).toBe(true);
  });

  test("an agent starting under a pane, because that dot is why you open it", () => {
    expect(readStrip(first(ONE), { canAttach: true, panes: [pane({ agentCwds: ["/home/x/code/work"] })] }).changed)
      .toBe(true);
  });

  test("a pane that is gone", () => {
    const shape = first({ canAttach: true, panes: [pane({}), pane({ paneId: "%2" })] });
    expect(readStrip(shape, ONE).changed).toBe(true);
  });

  test("and the server dropping `canAttach`, which draws a line of its own", () => {
    // Not a tab, but it is on the screen: the "this computer is older than the
    // pane attach" note lives or dies on it.
    expect(readStrip(first(ONE), { panes: [pane({})] }).changed).toBe(true);
  });

  test("a body that is not the shape it claims is an empty strip, not a throw", () => {
    // `panes` is annotated on the fetch and checked by nobody. An older or
    // broken server answering `{ok:false}` must empty the strip, not take the
    // screen down — see `fleet-shapes.test.ts` for the render error that
    // taught this.
    const read = readStrip(null, { canAttach: true, panes: undefined });
    expect(read.changed).toBe(true);
    if (!read.changed) return;
    expect(read.tabs).toEqual([]);
  });
});

/*
 * ── the wiring, read off the screen's own source ──────────────────────────
 *
 * `readStrip` answering "nothing changed" only buys anything if the screen
 * believes it before it writes any state. Nothing about the rendered output
 * says whether it does — the app is correct either way, once — so the rule is
 * asserted against the code, which is where it lives.
 */
const source = readFileSync(join(import.meta.dir, "..", "app", "(tabs)", "terminal.tsx"), "utf8");

/** The body of `load`, from its declaration to its dependency array. */
function loadBody(): string {
  const start = source.indexOf("const load = useCallback(");
  expect(start, "`load` moved or was renamed — this test is reading the wrong code").toBeGreaterThan(0);
  const end = source.indexOf("}, [host]);", start);
  expect(end, "no dependency array closing `load`").toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("what the screen does with an unchanged answer", () => {
  test("nothing at all: every setter is behind the guard", () => {
    const body = loadBody();
    const guard = body.indexOf("if (!next.changed) return;");
    expect(guard, "the guard that makes the poll survivable is gone").toBeGreaterThan(0);
    // The failure branch above it writes state on purpose — an unreachable
    // computer is an answer. Everything from the read onwards is the success
    // path, and that is what must be behind the guard.
    const read = body.indexOf("readStrip(seen.current");
    expect(read, "`load` no longer compares against the last shape").toBeGreaterThan(0);
    expect(read).toBeLessThan(guard);

    const setters = [...body.matchAll(/\bset[A-Z]\w*\(/g)]
      .map((m) => ({ name: m[0], at: m.index }))
      .filter((s) => s.at > read);
    // Not vacuous: the success path does write state, once it knows there is
    // something to write.
    expect(setters.length).toBeGreaterThan(0);
    for (const setter of setters) {
      expect(setter.at, `${setter.name} runs before the guard — every tick would repaint the strip`)
        .toBeGreaterThan(guard);
    }
  });
});

describe("when the poll runs", () => {
  test("only while the screen is focused, and it is cleaned up on the way out", () => {
    /*
     * A tab screen stays MOUNTED when you leave it, so a `useEffect` here would
     * go on polling from Settings and behind a locked phone. `useFocusEffect`
     * is the honest question, and its cleanup runs on leaving the tab.
     */
    const at = source.indexOf("useFocusEffect(useCallback(");
    expect(at, "the poll is not on focus any more").toBeGreaterThan(0);
    const block = source.slice(at, source.indexOf("}, [load]));", at));
    expect(block).toContain("setInterval(");
    expect(block).toContain("clearInterval(timer)");
    // One timer in the whole screen, and it is that one. A second one started
    // from a mount effect is the leak this test exists to refuse.
    expect([...source.matchAll(/setInterval\(/g)]).toHaveLength(1);
  });

  test("no faster than a second, because the server pays for every tick", () => {
    /*
     * `/terminal/panes` is synchronous `tmux` calls on Bun's single event loop:
     * measured at 24 ms per request against the machine this was reported on,
     * 17 panes across its tmux servers — and the terminal's own pty bytes queue
     * behind those 24 ms. 2000 is what it was set to; anything under a second
     * is spending more than a percent of the server on watching for a hand
     * splitting a pane.
     */
    const ms = Number(/setInterval\([^,]+,\s*(\d+)\)/.exec(source)?.[1]);
    expect(ms).toBeGreaterThanOrEqual(1000);
  });
});
