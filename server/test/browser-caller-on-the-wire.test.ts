/*
 * The ask frame finally carries WHO IS ASKING.
 *
 * The incident that forced this: "another agent was getting into that
 * container and typing its own data into that screen." Two agents, one tab,
 * and nobody wrong — because an ask carried an op and its arguments and nothing
 * at all about its sender, so the panel resolving a bare `read` to "the tab in
 * front" had nothing to compare against. Every check written on the panel side
 * before this landed would have been comparing with `undefined`.
 *
 * Four fields, and each one is load-bearing:
 *   `as`            who is asking; ABSENT means unverifiable, never mismatch.
 *   `pageExplicit`  the operator typed `--page` (the CLI injects one on every
 *                   acting verb, so the field alone cannot mean this).
 *   `acts`          read or write, decided once here where `OBSERVE_OPS` lives.
 *   `pageBound`     aimed at a page inside a tab, as opposed to the tab list.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseAsk, resetAudit, resetBrowserDrive } from "../src/browserdrive.ts";

afterEach(() => { resetBrowserDrive(); resetAudit(); });

/** The args of a parsed ask, or the reason it was refused. */
const args = (op: string, body: Record<string, unknown>): Record<string, unknown> => {
  const r = parseAsk(op, body);
  if ("error" in r) throw new Error(`refused: ${r.error}`);
  return r.ask.args;
};

describe("who is asking, on every op", () => {
  test("a read carries it", () => {
    expect(args("read", { as: "orbit" }).as).toBe("orbit");
  });

  test("so does a verb that acts, and one that only names a tab", () => {
    expect(args("click", { selector: "#save", as: "orbit" }).as).toBe("orbit");
    expect(args("tabs", { as: "orbit" }).as).toBe("orbit");
  });

  test("absent stays absent — that is what keeps MCP and `--shared` working", () => {
    /* `toBeUndefined`, not a truthiness check: the panel's rule is "no `as` on
       the wire means cannot-tell, and cannot-tell is allowed". A default value
       invented here would turn every nameless client into a mismatch. */
    expect(args("read", {}).as).toBeUndefined();
    expect(args("read", {}).acts).toBeUndefined();
    expect(args("read", {}).pageBound).toBeUndefined();
  });

  test("an empty or oversized name is refused rather than trimmed to nothing", () => {
    expect(parseAsk("read", { as: "   " })).toHaveProperty("error");
    expect(parseAsk("read", { as: "x".repeat(129) })).toHaveProperty("error");
    expect(parseAsk("read", { as: 7 })).toHaveProperty("error");
  });
});

describe("read or write, decided where the verb list lives", () => {
  test("a read is not acting", () => {
    expect(args("read", { as: "orbit" }).acts).toBe(false);
    expect(args("shot", { as: "orbit" }).acts).toBe(false);
  });

  test("a click is", () => {
    expect(args("click", { selector: "#save", as: "orbit" }).acts).toBe(true);
  });

  test("and the verbs that are two verbs in one name are still told apart", () => {
    /* `cookies` reads the jar or writes to it under the same name. The panel
       cannot make this call — nothing under web/ imports from server/ — so if
       this ever collapses to a per-op verdict, a `cookies --set` on somebody
       else's tab gets refused under the wording for a read. */
    expect(args("cookies", { as: "orbit" }).acts).toBe(false);
    expect(args("cookies", { set: { name: "a", value: "b" }, as: "orbit" }).acts).toBe(true);
  });
});

describe("aimed at a page, or at the tab list", () => {
  test("the list verbs are not page-bound", () => {
    /* Otherwise `newtab --as A` gets refused for asking for its own tab while
       somebody else's is in front — the exact false positive that would make
       this whole change a regression. */
    for (const op of ["tabs", "newtab", "closetab", "profiles", "health"]) {
      const body: Record<string, unknown> = { as: "orbit" };
      if (op === "newtab") body.url = "https://example.com/";
      if (op === "closetab") body.index = 0;
      expect(args(op, body).pageBound).toBe(false);
    }
    expect(args("tab", { id: "t7", as: "orbit" }).pageBound).toBe(false);
  });

  test("an `open` that names a container mints its own tab, so neither is it", () => {
    /* The panel routes exactly this shape to the tab verbs. Judge it against
       the tab in front and an identity with no tab is refused for trying to
       get one — a refusal nobody can answer, which is how `--shared` ends up
       on everything. */
    expect(args("open", { url: "https://example.com/", profile: "orbit", as: "orbit" }).pageBound).toBe(false);
  });

  test("a plain `open` replaces the current view, so it very much is", () => {
    /* The incident's own shape: the leading `open` of each batch destroyed the
       victim's page before any read could see it. */
    expect(args("open", { url: "https://example.com/", as: "orbit" }).pageBound).toBe(true);
  });

  test("a verb about the page is", () => {
    expect(args("read", { as: "orbit" }).pageBound).toBe(true);
    expect(args("click", { selector: "#save", as: "orbit" }).pageBound).toBe(true);
  });
});

describe("`--page` the operator typed, versus `page` the CLI filled in", () => {
  test("an injected page is not explicit", () => {
    /* This is the distinction the whole exemption rests on. The CLI stamps the
       caller's own tab onto every acting verb, so "the body has a page" cannot
       mean "the caller asked for somebody else's". */
    expect(args("read", { as: "orbit", page: "t9" }).pageExplicit).toBeUndefined();
  });

  test("a typed one is", () => {
    expect(args("read", { as: "orbit", page: "t9", pageExplicit: true }).pageExplicit).toBe(true);
  });

  test("the marker alone, with no page, buys nothing", () => {
    /* Otherwise `pageExplicit: true` on a bare verb is a blanket exemption
       from the ownership check, which is the check wearing an off switch. */
    expect(args("read", { as: "orbit", pageExplicit: true }).pageExplicit).toBeUndefined();
  });
});

describe("`tab <id>` is the operator naming a tab, and it keeps counting", () => {
  test("a verb routed to the tab you just named is explicit", () => {
    /* The CLI rebinds ownership on `tab <id>`: afterwards `my-tabs.json` maps
       the caller to that tab and every later verb ships the id INJECTED. Without
       this the measured fix for "`tab A; shot` returned B's picture" turns into
       "`tab A; shot` is refused", which is a regression wearing a safety vest. */
    args("tab", { id: "t5-4oueyw", as: "wf-probe" });
    expect(args("shot", { as: "wf-probe", page: "t5-4oueyw" }).pageExplicit).toBe(true);
  });

  test("a DIFFERENT tab is not", () => {
    args("tab", { id: "t5-4oueyw", as: "wf-probe" });
    expect(args("shot", { as: "wf-probe", page: "t9-other" }).pageExplicit).toBeUndefined();
  });

  test("naming a tab for one identity does not name it for another", () => {
    args("tab", { id: "t5-4oueyw", as: "wf-probe" });
    expect(args("read", { as: "orbit", page: "t5-4oueyw" }).pageExplicit).toBeUndefined();
  });

  test("switching away drops the old one — an exemption is a statement, not a licence", () => {
    args("tab", { id: "t5-4oueyw", as: "wf-probe" });
    args("tab", { id: "t9-mine", as: "wf-probe" });
    expect(args("read", { as: "wf-probe", page: "t9-mine" }).pageExplicit).toBe(true);
    expect(args("read", { as: "wf-probe", page: "t5-4oueyw" }).pageExplicit).toBeUndefined();
  });

  test("the ledger is bounded, because a caller supplies the key", () => {
    /* Reachable from an unauthenticated local caller. 64 identities in, the
       first is gone; the 64 most recent all still hold. */
    for (let i = 0; i < 80; i++) args("tab", { id: `t${i}`, as: `agent${i}` });
    expect(args("read", { as: "agent0", page: "t0" }).pageExplicit).toBeUndefined();
    expect(args("read", { as: "agent79", page: "t79" }).pageExplicit).toBe(true);
    expect(args("read", { as: "agent16", page: "t16" }).pageExplicit).toBe(true);
  });

  test("and it does not survive a reset", () => {
    args("tab", { id: "t5-4oueyw", as: "wf-probe" });
    resetBrowserDrive();
    expect(args("read", { as: "wf-probe", page: "t5-4oueyw" }).pageExplicit).toBeUndefined();
  });
});

describe("§12: `--show` now crosses the wire", () => {
  test("a mint says whether it may take the pane", () => {
    /* It used to be a CLI-only retry flag, because there was nothing on this
       side that could act on it: minting ALWAYS moved the pointer. */
    expect(args("newtab", { url: "https://example.com/", show: true }).show).toBe(true);
    expect(args("open", { url: "https://example.com/", show: true }).show).toBe(true);
  });

  test("silence means background, which is the new default", () => {
    expect(args("newtab", { url: "https://example.com/" }).show).toBeUndefined();
  });
});
