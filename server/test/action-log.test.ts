/*
 * Who did what, kept — #299.
 *
 * The cockpit performs real writes: it discards, force-pushes, merges pull
 * requests, removes containers, and answers the gate that has an agent stopped
 * at the other end of it. The only record was a ring buffer that says of itself
 * it is "a live view of the current session, not an audit trail"
 * (gitlog.ts:11), so "who approved that" had no answer at all.
 *
 * The last test is the one with a future: an audit trail with a hole in it is
 * worse than none, because you stop looking for the missing line. So the rule
 * is asserted over the routing table rather than over the four sites that
 * exist today.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { actorOf, targetOf } from "../src/actions.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-actions-"));
process.env.AGENTGLASS_DB = join(dir, "actions.db");
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
beforeAll(async () => { db = await import("../src/db.ts"); });

describe("who", () => {
  test("a loopback caller is this machine, not an address", () => {
    // The dashboard fetches itself thousands of times; "127.0.0.1" on every
    // line would be noise standing in for the only case that needs no name.
    for (const ip of ["127.0.0.1", "127.0.1.1", "::1", "::ffff:127.0.0.1"]) {
      expect(actorOf(ip), ip).toBe("local");
    }
    expect(actorOf(null)).toBe("local");
    expect(actorOf(undefined)).toBe("local");
  });

  test("anything else is the address it came from", () => {
    // The whole point: "I approved that from my phone" becomes answerable.
    expect(actorOf("192.168.1.42")).toBe("192.168.1.42");
    // Bun hands back v4-mapped v6 on a dual-stack listener; the log should not
    // show two different actors for one phone.
    expect(actorOf("::ffff:192.168.1.42")).toBe("192.168.1.42");
  });
});

describe("what it was done to", () => {
  test("a git write names the files, not just the repo", () => {
    // "discarded shop-api" tells you nothing you needed; the path is the whole
    // reason to read the line.
    expect(targetOf("/git/discard", { root: "/home/you/code/shop-api", paths: ["src/pay.ts"] }))
      .toBe("shop-api src/pay.ts");
  });

  test("a git write with no paths names whatever else identifies it", () => {
    expect(targetOf("/git/branch-delete", { root: "/home/you/code/shop-api", name: "feat/coupon" }))
      .toBe("shop-api feat/coupon");
    expect(targetOf("/git/stash-drop", { root: "/home/you/code/shop-api", index: 2 }))
      .toBe("shop-api #2");
  });

  test("a gate names what was held, not the uuid it was held under", () => {
    expect(targetOf("/gate/deny", { tool: "Bash", summary: "rm -rf build" }))
      .toBe("Bash · rm -rf build");
  });

  test("a pull request names the repo and the number", () => {
    expect(targetOf("/prs/merge", { root: "/home/you/code/shop-api", number: 482 })).toBe("shop-api #482");
  });

  test("a commit message is clipped rather than kept whole", () => {
    // A body belongs in the commit, not in a log line about it — and an
    // unbounded field here is an unbounded row for every future write.
    const t = targetOf("/git/commit-staged", { root: "/r", title: "x".repeat(500) });
    expect(t.length).toBeLessThanOrEqual(120);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("the record", () => {
  test("a write is kept, with its outcome", () => {
    db.recordAction({ actor: "local", action: "/git/push", target: "agentglass", ok: false, detail: "rejected" });
    const [row] = db.actionLog(1);
    expect(row!.action).toBe("/git/push");
    expect(row!.ok).toBe(0);
    expect(row!.detail).toBe("rejected");
  });

  test("newest first, and pageable past the newest", () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      db.recordAction({ actor: "local", action: `/git/stage`, target: `f${i}`, ok: true, at: base + i });
    }
    const page = db.actionLog(3);
    expect(page.map((a) => a.target)).toEqual(["f4", "f3", "f2"]);
    // `before` is what a "load more" needs, and an off-by-one here would either
    // repeat a row or skip one.
    expect(db.actionLog(2, page[2]!.at).map((a) => a.target)).toEqual(["f1", "f0"]);
  });

  test("a failed write to the log does not fail the action it was recording", () => {
    // The action already happened. Losing its line is bad; throwing after the
    // branch is already deleted is worse.
    expect(() => db.recordAction({
      actor: "local", action: "/git/push", ok: true,
      detail: { toString() { throw new Error("nope"); } } as unknown as string,
    })).not.toThrow();
  });
});

describe("nothing writes without being recorded", () => {
  /*
   * The three families each route through one switch, and the gate through its
   * own handler. That is four places to instrument today — and exactly four
   * places for a fifth to be added without one.
   */
  const index = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

  test("every write chokepoint records before it answers", () => {
    // Each family ends in a single `if (res) return json(res, …)`. Find them
    // all and require noteAction on the same line.
    const returns = index.split("\n").filter((l) => /if \(res\) .*return json\(res/.test(l));
    expect(returns.length, "the write switches were restructured — re-check this guard").toBe(3);
    for (const line of returns) {
      expect(line, "a write family answers without recording").toContain("noteAction(");
    }
  });

  test("the gate decision records too", () => {
    const at = index.indexOf('pathname === "/gate/decide"');
    expect(at).toBeGreaterThan(-1);
    const handler = index.slice(at, index.indexOf("\n    }", at));
    expect(handler).toContain("noteAction(");
    // Read before deciding, or the row is already resolved and the line loses
    // the only part worth keeping.
    expect(handler.indexOf("getGate(")).toBeLessThan(handler.indexOf("decideGate("));
  });

  test("a chat launch is recorded, and its prompt is not", () => {
    // #299 names chat-initiated runs. What is auditable is that somebody
    // started an agent in a checkout; the prompt is already in the transcript
    // and in `events`, and a second copy in a table nothing prunes is a copy
    // nobody asked for.
    const at = index.indexOf('pathname === "/chat/send"');
    expect(at).toBeGreaterThan(-1);
    const handler = index.slice(at, index.indexOf("\n    }", at));
    expect(handler).toContain("noteAction(");
    expect(handler, "the prompt must not reach the audit log").not.toMatch(/noteAction\([^)]*b\.message/s);
    expect(targetOf("/chat/send", { root: "/home/you/code/shop-api", name: "opus" })).toBe("shop-api · opus");
  });

  test("/control is left out, and that is a decision rather than an oversight", () => {
    // It moves the UI's own focus and grants nothing the keyboard does not
    // already have, so logging it would bury the merges under navigation.
    const at = index.indexOf('pathname === "/control"');
    expect(at).toBeGreaterThan(-1);
    expect(index.slice(at, at + 600)).not.toContain("noteAction(");
  });
});
