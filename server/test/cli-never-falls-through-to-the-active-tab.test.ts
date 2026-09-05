/*
 * AN IDENTITY WITH NO TAB REFUSES. IT DOES NOT FALL THROUGH.
 *
 * A request that names no tab is not "unspecified" to the relay — it is "the
 * tab in front", whoever owns it. The CLI had two ways to emit one while the
 * caller believed it was isolated:
 *
 *   1. The targeting block added `page` only `if mine:` and had no `else`, so
 *      an identity whose remembered tab was gone went out bare. Nobody has to
 *      make a mistake for that: a tab is lost when it is closed, when an open
 *      failed, when the state file cannot be read, and when the app restarts —
 *      which invalidates every agent's remembered id at once.
 *   2. `session`, `permissions`, `cdp` and `do` return from the dispatcher
 *      about four hundred lines BEFORE identity is resolved, so `--as NAME`
 *      was parsed and thrown away for them.
 *
 * Measured in the incident behind this: an agent that passed `--as` on all 25
 * of its invocations navigated another agent's tab seven times and clicked
 * into it seven times, `ok: true` every time, with no signal on either side —
 * the victim addresses its tab by id, the tab still exists, only the page
 * inside it changed.
 *
 * Held on the CLI's source because that is where the decision is made, and the
 * CLI is Python in a repo whose tests are TypeScript.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const cli = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");
const at = (needle: string) => {
  const i = cli.indexOf(needle);
  expect(i, `${needle} is not in the CLI`).toBeGreaterThan(0);
  return i;
};

describe("the targeting block", () => {
  test("refuses when the identity has no live tab", () => {
    const block = cli.slice(at('if a.cmd not in TAB_OPS and "page" not in body:'), at("    res = call(a.cmd, body)"));
    expect(block).toContain('body["page"] = mine');
    /* The `else` that was missing. Its absence is the whole of PATH 2. */
    expect(block).toContain("elif who and \"profile\" not in body:");
    expect(block).toContain("return 1");
    /* The sentence itself lives in `no_tab_refusal` now — there were three
       copies of it and they had already drifted, two of them naming `--shared`
       as the way to reach the front tab after `--shared` stopped meaning that.
       A refusal is the only thing a stuck caller reads; it does not get to be
       out of date, so it is written once. */
    expect(block).toContain("no_tab_refusal(who, a.cmd)");
  });

  test("and tells the caller all three ways forward", () => {
    /* A refusal that leaves somebody stuck gets worked around, and the
       work-around is `--shared` on everything. */
    const fn = cli.slice(at("def no_tab_refusal(who, verb):"), at("def cursor_key(a):"));
    expect(fn).toContain("open one:");
    expect(fn).toContain("--page");
    /* `--active`, not `--shared`. `--shared` is the person's own container now
       — a container like any other, which needs a tab open in it — so naming
       it here would send a stuck caller at the very call that drives another
       agent's page. */
    expect(fn).toContain("--active");
    expect(fn).toContain("whoami");
  });
});

describe("the four verbs that answered before identity was resolved", () => {
  /* Each one's handler, from its `if a.cmd ==` to the next. */
  const handler = (verb: string, next: string) =>
    cli.slice(at(`if a.cmd == "${verb}":`), at(`if a.cmd == "${next}":`));

  test("session asks first — it is the one that dumps cookies and localStorage", () => {
    const h = handler("session", "permissions");
    expect(h).toContain("addressed(a,");
    expect(h).toContain("return 1");
    /* And the tab reaches the calls that read the login. */
    expect(cli).toContain('call("cdp", stamped(a, _at(page, {"method": "Network.getCookies"})))');
    expect(cli).toContain("def session_save(path, page=");
  });

  test("permissions asks first", () => {
    expect(handler("permissions", "cdp")).toContain("addressed(a,");
  });

  test("cdp asks first, and its body carries the tab", () => {
    const h = handler("cdp", "do");
    expect(h).toContain("addressed(a,");
    expect(h).toContain('call("cdp", stamped(a, _at(page, body)))');
  });

  test("do asks first — a read-only batch is the dangerous one", () => {
    const h = cli.slice(at('if a.cmd == "do":'), at('if a.cmd in ("dblclick"'));
    expect(h).toContain("addressed(a,");
    expect(h).toContain('call("do", stamped(a, _at(page,');
  });

  test("and every one of their requests says who is asking", () => {
    /*
     * The tab was fixed for the four first, and the NAME was not: `as`, `how`
     * and `pageExplicit` were stamped in the main path only, three hundred
     * lines after these returned. The panel reads a missing `as` as "cannot
     * tell" and allows, so the four went out addressed and anonymous — and
     * `do` above all, the incident's own vector. One helper, every literal
     * `call(`: a new early return gets it or this goes red.
     */
    const literal = [...cli.matchAll(/\bcall\("[a-z]+",\s*([^\n]*)/g)];
    expect(literal.length).toBeGreaterThanOrEqual(7);
    for (const m of literal) expect(m[0], m[0]).toContain("stamped(a, ");
    /* And the main path stamps before it sends. */
    const main = cli.slice(at("body = stamped(a, body, who)"), at("res = call(a.cmd, body)"));
    expect(main, "something reaches the wire between the stamp and the send").not.toContain("call(");
  });
});

describe("--shared and --active are refused before any verb runs", () => {
  test("the check is in main(), before the first call()", () => {
    const start = at("def main():");
    const end = cli.indexOf('res = call(a.cmd, body)');
    const main = cli.slice(start, end);
    const check = main.indexOf('getattr(a, "shared", False) and getattr(a, "active", False)');
    const firstCall = main.indexOf("call(");
    expect(check).toBeGreaterThan(0);
    expect(firstCall, "the --shared/--active check has to come before the first call(), or it can be bypassed").toBeGreaterThan(check);
  });

  test("and a body with no page is left exactly as it was", () => {
    /* `_at` must not invent a page: `--shared` means the active tab, and
       adding an empty one would be a different request. */
    const fn = cli.slice(at("def _at(page, body):"), at("def addressed(a, cmd=None):"));
    expect(fn).toContain("if page:");
    expect(fn).toContain("return body");
  });
});

describe("but a request that IS addressed by profile is not refused", () => {
  test("`open` and `newtab` carry a container, which is a target of its own", () => {
    /*
     * The first version of the guard did not know that and refused them —
     * caught at once by the CLI suite, twenty tests, every one of which opens
     * before it acts. "Make me a tab in this container" is perfectly
     * addressed, and refusing it leaves an identity with no tab no way to get
     * one: a refusal nobody can answer is a refusal that gets worked around
     * with `--shared` on everything, which is the hole reopened by hand.
     */
    const block = cli.slice(at('if a.cmd not in TAB_OPS and "page" not in body:'), at("    res = call(a.cmd, body)"));
    expect(block).toContain('"profile" not in body');
  });
});
