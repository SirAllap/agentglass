/*
 * Every route the server registers, enumerated from the source, and the rule
 * that anything which executes or mutates sits behind an Origin gate.
 *
 * `mutating-routes-guard.test.ts` next door asks the same question of a list
 * somebody typed. That list is right today and cannot stay right: `index.ts`
 * is four thousand lines carrying two hundred-odd routes and took 162 commits
 * in the last sixty days, so the failure mode is not a guard being removed —
 * it is a guard never being written, on a route the list has never heard of.
 * #469 is what that looks like at scale: 22 mutating routes on the permissive
 * gate, none of them wrong on purpose, every one copied from whichever
 * neighbour was nearest. A hand-kept list cannot catch that, because the route
 * that is missing from the code is missing from the list too.
 *
 * Nor is this something to leave until there is a second contributor to
 * protect against. Fourteen people outside this repo have already opened pull
 * requests against it; the condition passed a long time ago.
 *
 * So this file carries no list of routes. `routeTable.ts` parses `index.ts`
 * and walks out every path the dispatcher can match — 365 of them today, 184
 * of which mutate — and the assertions below apply the rule to all of them.
 * Adding a route without a gate turns this red without anybody remembering to
 * come here. What is hand-written is the two small maps: EXEMPT, for routes
 * that may answer an Origin-less caller and the reason each may, and
 * KNOWN_GAPS, for the two that should have a gate and do not.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE, label, mutates, readRoutes } from "./routeTable.ts";

/*
 * Deliberate exceptions, each with the reason it is one.
 *
 * Keep this list short and keep the reasons true. An entry here is a decision
 * that a route which mutates or executes may be reached by a caller that sent
 * no Origin header — which on the `AGENTGLASS_BIND=0.0.0.0` install the README
 * documents means any machine that can reach the port. There are three reasons
 * on the list and no others: seven callers that are subprocesses rather than
 * browsers and have no Origin to send, six steps of the pairing handshake that
 * happen before the device on the other end is trusted at all, and one read
 * that takes a POST because the question needs a body.
 */
const EXEMPT = new Map<string, string>([
  ["POST /ingest",
    "The Claude Code hooks POST here from a subprocess. No browser, no Origin " +
    "header to send, and turning them away turns off the product's own intake."],
  ["POST /v1/traces",
    "OTLP exporters in other CLIs. Same reason as /ingest: a non-browser " +
    "client that has no Origin to offer."],
  ["POST /otlp/v1/traces", "The prefixed spelling of the same OTLP receiver."],
  ["POST /v1/logs", "The OTLP log receiver, same non-browser callers."],
  ["POST /otlp/v1/logs", "The prefixed spelling of the same OTLP receiver."],
  ["POST /statusline",
    "Claude Code's statusline command pipes its JSON in from a subprocess, " +
    "with no browser anywhere in the chain."],
  ["POST /gate",
    "The hook that asks for permission and blocks on the answer. It is the " +
    "agent's own subprocess, so it has no Origin either — and a gate that " +
    "cannot be asked is a gate that never holds anything."],
  ["POST /git/status",
    "A read wearing a POST: it takes a body because the question needs a list " +
    "of paths, not because it changes anything. Pinned so a later sweep does " +
    "not tighten it and break the hooks that call it."],
  ["POST /pair/ticket",
    "Pairing a phone. The device on the other end is not yet trusted by " +
    "definition — that is what pairing is for — and the flow is protected by " +
    "the short-lived ticket and the user pressing accept, not by Origin."],
  ["POST /pair/cancel", "Same pairing flow; cancels a ticket the caller already holds."],
  ["POST /pair/accept", "Same pairing flow; the desk's own answer to a waiting device."],
  ["POST /pair/reject", "Same pairing flow; the desk's own answer to a waiting device."],
  ["POST /pair/forget", "Same pairing flow; drops a device the user chose to drop."],
  ["POST /pair/claim",
    "The phone redeeming its ticket for a token. It is the one call a device " +
    "makes before it has anything to authenticate with."],
]);

/*
 * The gaps this test found the day it was written, and they are NOT
 * exemptions. Nobody decided these two may answer an Origin-less caller; they
 * are the #469 failure repeating on a smaller scale — a route that landed a
 * few hundred lines above the family block that would have gated it, and one
 * that reached for a different kind of gate and stopped there.
 *
 * They are listed rather than fixed because fixing a route means editing
 * `index.ts`, and this file only reads it. The list is written so it can only
 * ever shrink: the test below asserts every entry is STILL unguarded, so the
 * commit that adds the gate is the commit that has to delete the line, and
 * nothing can be quietly parked here.
 */
const KNOWN_GAPS = new Map<string, string>([
  ["POST /remote/device",
    "Blocks or unblocks a phone, and closes its open sockets. It does have a " +
    "gate — `isLoopback(clientIp)` — which is stricter than trustedCaller " +
    "about the network and blind to the thing trustedCaller is for: a page in " +
    "the user's own browser reaches 127.0.0.1 and passes it. The Origin check " +
    "belongs on top of the address check, not instead of it."],
]);

/** Both lists together: a route here is not reported, for one reason or another. */
const ACCOUNTED_FOR = new Map([...EXEMPT, ...KNOWN_GAPS]);

const ROUTES = readRoutes();

describe("every route the dispatcher can match", () => {
  /*
   * A floor, not an exact count: the number goes up every week and a test that
   * pins it exactly is a test that gets updated without being read. What this
   * catches is the parser breaking — a refactor of the dispatcher into some
   * shape this walker does not recognise would report a handful of routes and
   * then pass the guard assertion below by finding nothing to check.
   */
  test("the parser still finds the whole surface", () => {
    expect(ROUTES.length).toBeGreaterThan(200);
    expect(ROUTES.filter((r) => r.kind === "case").length).toBeGreaterThan(80);
    expect(ROUTES.filter(mutates).length).toBeGreaterThan(120);
  });

  /*
   * And the part that makes the rest of this file worth trusting: the same
   * walker, pointed at a copy of `index.ts` with a gate taken out and a new
   * route slipped in, reports both.
   *
   * Without this, every assertion below is satisfied by a parser that has
   * quietly stopped understanding the dispatcher — it would find nothing to
   * complain about and pass, which is the failure mode of every test that
   * checks a set for emptiness. The copy is a scratch file, never the real
   * source; nothing here writes to `src/`.
   */
  test("the walker reports a gate that was deleted and a route that was added", () => {
    const original = readFileSync(SOURCE, "utf8");

    // The gate over the whole `/prs/` family, removed. Everything the switch
    // inside it dispatches — review, merge, comment — should fall out ungated.
    const familyGate =
      '    if (pathname.startsWith("/prs/") && req.method === "POST") {\n'
      + "      if (!trustedCaller(req, from)) return csrfBlocked();";
    expect(original, "the /prs/ family gate is not where this test expects it").toContain(familyGate);

    // A route a contributor might add on a Friday, in the house style, with
    // the one line missing that this whole file exists to require.
    const newRoute =
      '    if (pathname === "/scratch/run" && req.method === "POST") {\n'
      + "      return json({ ok: true });\n"
      + "    }\n";

    const dir = mkdtempSync(join(tmpdir(), "agx-route-guard-"));
    const copy = join(dir, "index.ts");
    writeFileSync(
      copy,
      original.replace(familyGate, '    if (pathname.startsWith("/prs/") && req.method === "POST") {')
        .replace('    if (pathname === "/health")', newRoute + '    if (pathname === "/health")'),
    );

    const open = readRoutes(copy).filter(mutates).filter((r) => !r.guarded).map(label);

    expect(open, "the added route was not reported").toContain("POST /scratch/run");
    expect(open, "the /prs/ family lost its gate and nothing noticed").toContain("POST /prs/*");
    expect(open.filter((l) => l.startsWith("POST /prs/")).length,
      "removing one family gate should expose every route inside it").toBeGreaterThan(10);

    // Same routes, unmodified source: guarded. Both directions, or the walker
    // could be reporting everything and still look right above.
    const today = ROUTES.filter(mutates).filter((r) => !r.guarded).map(label);
    expect(today).not.toContain("POST /prs/*");
    expect(today).not.toContain("POST /scratch/run");
  });

  /*
   * Both hand-written lists are kept honest against the code they describe: an
   * entry must still name a route that exists, still mutates, and still has no
   * gate. That last clause is what stops the lists becoming a graveyard —
   * whoever puts the guard on `/prs/conflict` finds this test telling them to
   * delete the line about it in the same commit.
   */
  test("nothing in the two lists describes a route that has moved on", () => {
    const open = new Set(ROUTES.filter(mutates).filter((r) => !r.guarded).map(label));
    const stale = [...ACCOUNTED_FOR.keys()].filter((k) => !open.has(k));
    expect(
      stale,
      `${stale.length} entr(y/ies) in EXEMPT or KNOWN_GAPS no longer match the ` +
      `code:\n${stale.map((x) => `  ${x}`).join("\n")}\n` +
      `Either the route is gone, or it stopped mutating, or somebody gave it ` +
      `the gate it was missing. Delete the entry: a stale exemption is one a ` +
      `future route with the same name inherits without anybody deciding it.`,
    ).toEqual([]);
  });

  /*
   * The gap list only shrinks. Growing it is how a list of things to fix turns
   * into a list of things that are fine, one plausible commit at a time.
   */
  test("the tracked gaps have not grown", () => {
    expect(KNOWN_GAPS.size).toBeLessThanOrEqual(2);
  });

  /*
   * The assertion the file exists for. One test over all of them rather than
   * one test each: a new unguarded route should read as "the rule is broken",
   * and the message has to hand back the path, the line and the fix, because a
   * red test nobody can act on is a red test somebody deletes.
   */
  test("everything that executes or mutates refuses an untrusted caller", () => {
    const offenders = ROUTES
      .filter(mutates)
      .filter((r) => !r.guarded)
      .filter((r) => !ACCOUNTED_FOR.has(label(r)));

    const report = offenders
      .map((r) => `  ${label(r)}  (src/index.ts:${r.line})`)
      .join("\n");

    expect(
      offenders.map((r) => `${label(r)} at src/index.ts:${r.line}`),
      offenders.length === 0 ? "" :
      `${offenders.length} route(s) execute or mutate without an Origin gate:\n${report}\n\n` +
      `Add this as the first statement of the route's block:\n` +
      `    if (!trustedCaller(req, from)) return csrfBlocked();\n` +
      `or, for anything that builds and runs code, the stricter\n` +
      `    if (!desktopOnly(req)) return csrfBlocked();\n\n` +
      `If the route genuinely must answer a caller with no Origin — a hook, an ` +
      `OTLP exporter, the pairing handshake — add it to EXEMPT in this file ` +
      `with the reason, so the decision is written down rather than assumed. ` +
      `A route that ought to be gated and is not goes in KNOWN_GAPS instead, ` +
      `which is a different sentence and reads like one.`,
    ).toEqual([]);
  });

  /*
   * The family gates are the load-bearing ones: five prefixes cover most of
   * the mutating surface, and a route added inside one of those blocks is
   * guarded before it is written. Checked separately so that a refactor which
   * splits a family apart is visible here rather than only as a hundred
   * individual failures above.
   */
  test("the family gates each still guard their whole block", () => {
    const families = ROUTES.filter((r) => r.kind === "prefix" && mutates(r));
    expect(families.length).toBeGreaterThan(5);
    const open = families.filter((r) => !r.guarded).map((r) => `${label(r)} at src/index.ts:${r.line}`);
    expect(
      open,
      `A prefix block that accepts POST without a gate lets every route inside ` +
      `it through unchecked:\n${open.map((s) => `  ${s}`).join("\n")}`,
    ).toEqual([]);
  });
});
