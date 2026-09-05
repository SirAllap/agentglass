/*
 * Two agents, one tab — the thing that must not happen again.
 *
 * "Another agent was getting into that container and putting its data on that
 * screen... the other agent was going in to take screenshots and could not,
 * because the first one kept overwriting on top." A proof-of-life run kept being
 * overwritten by an agent that believed it was isolated. It was: isolation here
 * is the TAB an identity holds, and an ask that names no tab is not
 * "unspecified" to the panel — it is "the tab in front", whoever owns it.
 *
 * The three rules that close it are pure functions in browserDrive.ts on
 * purpose. Under `bun test` there is no DOM and effects never run, so anything
 * left inside BrowserPanel's ask handler is a rule with no lock on it; the
 * wiring is checked separately at the bottom of this file, by reading the
 * handler between two landmarks rather than at a byte offset that the next
 * comment moves.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  crossContainerRefusal, mintTakesThePane, runBrowserAsk, stampWhere,
  type AskOwnership, type DrivableWebview,
} from "../src/lib/browserDrive.ts";

/** A's tab, in A's container, asked about by whoever the test says. */
const owned = (over: Partial<AskOwnership> = {}): AskOwnership => ({
  tab: "t5-4oueyw", container: "orbit-ops", as: "wf-probe",
  pageExplicit: false, acts: true, ...over,
});

describe("a cross-container act is refused, and both owners are named", () => {
  test("the refusal names the tab, its container and the caller", () => {
    const why = crossContainerRefusal(owned());
    /* `not.toBeNull()` and not `toBeDefined()`: a null IS defined, so the
       obvious assertion here passes for a function that refuses nothing. */
    expect(why).not.toBeNull();
    expect(why).toContain("t5-4oueyw");
    expect(why).toContain('"orbit-ops"');
    expect(why).toContain('"wf-probe"');
    /* And the way out, both halves of it — a refusal a caller cannot answer is
       a refusal that gets worked around instead of read. */
    expect(why).toContain("open --as wf-probe");
    expect(why).toContain("--page t5-4oueyw");
  });

  test("your own tab is served", () => {
    expect(crossContainerRefusal(owned({ as: "orbit-ops" }))).toBeNull();
  });

  test("the unprofiled tab belongs to `default`, said out loud", () => {
    /* An empty string reads as "not set" when it means "the shared space every
       other agent is also in" — so the panel never passes one, and `default`
       is a container name like any other. */
    expect(crossContainerRefusal(owned({ container: "default", as: "default" }))).toBeNull();
    expect(crossContainerRefusal(owned({ container: "default" }))).not.toBeNull();
  });

  test("no identity on the wire is unverifiable, not a mismatch", () => {
    /* The MCP surface and any hand-written client send no `as` at all, and
       `--shared` deliberately sends none either. If this ever returns a string
       the change breaks every one of them on the day it lands. */
    expect(crossContainerRefusal(owned({ as: "" }))).toBeNull();
  });

  test("an explicitly named page is the whole exemption", () => {
    expect(crossContainerRefusal(owned({ pageExplicit: true }))).toBeNull();
  });

  test("a read is refused too, under a prefix a caller can branch on", () => {
    /* Same rule for both, argued in the spec rather than assumed: the measured
       harm from an unowned read was evidence contamination — 15 KB of somebody
       else's DOM, `ok: true`, and a conclusion filed from it. The prefix is the
       one concession: a read can be retried with `--page` mechanically. */
    const read = crossContainerRefusal(owned({ acts: false }));
    const act = crossContainerRefusal(owned({ acts: true }));
    expect(read).not.toBeNull();
    expect(read).toStartWith("cross-container read refused:");
    expect(act).toStartWith("cross-container act refused:");
  });
});

describe("a tab an agent mints does not take the visible pane", () => {
  test("with something already up, the mint stays in the background", () => {
    expect(mintTakesThePane({ existing: 3, show: false })).toBe(false);
  });

  test("an empty window shows what it just made", () => {
    /* Otherwise the person is left looking at an empty pane with no way back to
       a page that now exists. */
    expect(mintTakesThePane({ existing: 0, show: false })).toBe(true);
  });

  test("`--show` still buys the old behaviour, per call", () => {
    expect(mintTakesThePane({ existing: 3, show: true })).toBe(true);
  });
});

describe("every answer says which tab it came from", () => {
  test("the two keys ride inside `value`", () => {
    /* Inside, not beside: /browser/result rebuilds the frame from ok/value/
       error/diagnosis, so a top-level key is dropped in transit. */
    const r = stampWhere({ ok: true, value: { url: "https://example.com/a" } as Record<string, unknown> },
      { tab: "t7", container: "orbit" });
    expect(r.value).toEqual({ url: "https://example.com/a", tab: "t7", profile: "orbit" });
  });

  test("a value that is not an object is left exactly as it was", () => {
    /* `text` prints a bare string and `shot` prints a bare path — stdout is a
       contract here, and wrapping either would break a shell pipeline. */
    expect(stampWhere({ ok: true, value: "plain text" }, { tab: "t7", container: "orbit" }).value)
      .toBe("plain text");
    expect(stampWhere({ ok: true, value: [1, 2] }, { tab: "t7", container: "orbit" }).value)
      .toEqual([1, 2]);
  });

  test("an unresolved ask is stamped with nothing rather than with blanks", () => {
    const r = stampWhere({ ok: true, value: { a: 1 } }, {});
    expect(r.value).toEqual({ a: 1 });
  });

  test("a real verb comes back carrying the tab the panel resolved", async () => {
    /* End to end through `runBrowserAsk`, because the stamp lives in a wrapper
       around a switch with some seventy returns: the point is that no verb has
       to remember to do it. */
    const el = {
      loadURL: async () => {}, goBack: () => {}, goForward: () => {},
      canGoBack: () => true, canGoForward: () => false,
      reload: () => {}, reloadIgnoringCache: () => {},
      getURL: () => "https://example.com/app", getTitle: () => "The app",
      executeJavaScript: async () => ({ kind: "ok" }),
      capturePage: async () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
      addEventListener: () => {}, removeEventListener: () => {},
    } as unknown as DrivableWebview;
    const reply = await runBrowserAsk(el, {
      id: "b1", op: "read", args: { atTab: "t7-orbit", atProfile: "orbit" },
    } as never);
    expect(reply.ok).toBe(true);
    const v = reply.value as { tab?: string; profile?: string };
    expect(v.tab).toBe("t7-orbit");
    expect(v.profile).toBe("orbit");
  });
});

/*
 * And the panel actually asks. Read between two landmarks — never at a byte
 * offset, which the next comment added to this file would move.
 */
const panel = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");

const between = (from: string, to: string): string => {
  const a = panel.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = panel.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return panel.slice(a, b);
};

/* The comments in this file are half its value and they quote the code they
   explain — including the exact line this test counts. So the counting is done
   on the CODE, or the lock reads its own documentation as a second call site. */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the panel is wired to all three", () => {
  test("the ask handler refuses before it serves", () => {
    const handler = between("setBrowserAskHandler((ask) => {", "setBrowserAskHandler(null)");
    /* `.includes()` into a boolean rather than `toContain` on the slice: this
       block is a hundred lines of prose, and a failure that prints all of it
       buries the one word that changed. */
    expect(handler.includes("crossContainerRefusal(")).toBe(true);
    /* The refusal has to come BEFORE the ask reaches a guest, or the page has
       already changed by the time anybody is told it should not have. */
    expect(handler.indexOf("crossContainerRefusal("))
      .toBeLessThan(handler.indexOf("void serveBrowserAsk(null, ask)"));
  });

  test("the handler hands the resolution down for the stamp", () => {
    const handler = between("setBrowserAskHandler((ask) => {", "setBrowserAskHandler(null)");
    expect(handler.includes("ask.args.atTab")).toBe(true);
    expect(handler.includes("ask.args.atProfile")).toBe(true);
  });

  test("`open` selects the new tab only through the rule", () => {
    /* The defect was one unconditional line: `addTab(...)` then set-active, on
       every mint. Any `setActiveId` in this block that is not under
       `mintTakesThePane` is that line growing back. */
    const open = code(between("    open: (url, wanted) => {", "    close: ({ index, id }) => {"));
    expect(open.includes("mintTakesThePane(")).toBe(true);
    expect(open.match(/setActiveId\(/g)?.length ?? 0).toBe(1);
    expect(open.indexOf("mintTakesThePane(")).toBeLessThan(open.indexOf("setActiveId("));
  });

  test("a person clicking a link still gets the tab they clicked", () => {
    /* The scope of §12 is tabs minted by an ASK. The panel's own `open`
       callback is the human path — the address bar, a link, the shelf — and it
       must keep focusing, or the change stops being about agents and starts
       being about breaking the browser. The two paths are eight lines apart in
       the file and the obvious tidy-up is to merge them. */
    const human = code(between(
      "const open = useCallback((url: string, from?: string, profile?: string, shelfId?: string) => {",
      "const close = useCallback("));
    expect(human.includes("setActiveId(r.tab.id)")).toBe(true);
    expect(human.includes("mintTakesThePane(")).toBe(false);
  });
});
