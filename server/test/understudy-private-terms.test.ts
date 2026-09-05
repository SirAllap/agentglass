/*
 * The gate that stands between a screen and a table, checked with terms that
 * are not real.
 *
 * agentglass is a public repository. The terms file this gate reads is, by
 * construction, the list of strings that must never appear in it — so a test of
 * the gate cannot use the real file and cannot use a real term. Every term
 * below is invented (an `orbit` project, an `ORBIT-1042` ticket, an `acmecorp`
 * customer) and the file they live in is written into a temp directory by this
 * test, which is also why `__setPrivateTermsPath` exists at all.
 *
 * The two things being proved are separable and both matter. The gate DETECTS,
 * and it reports what it found as an INDEX — so a failing assertion, a stack
 * trace and a quarantine row are all safe to paste in public. And the seal
 * REFUSES: the ledger row still gets written, because the situation genuinely
 * happened and losing it would lose a scored decision, while the body is
 * dropped on the floor and only the fact of the refusal is kept.
 *
 * The last test in the first block is the broad one: a scan of every understudy
 * table for the term text, wherever it might have ended up. A targeted
 * assertion proves the column you thought of is clean; this one is about the
 * column you did not.
 *
 * ISOLATION: `bun test` shares one module registry across files, so each
 * understudy test file owns its own classes rather than its own database. This
 * one is the only user of C11.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-understudy-terms-"));
process.env.AGENTGLASS_DB = join(dir, "terms.db");
process.env.XDG_CONFIG_HOME = dir;

/*
 * The planted file, with the line index of each term written beside it —
 * `term_index` is the zero-based line, so the comment on line 0 shifts
 * everything and that shift is exactly what the assertions pin.
 *
 *   0  a comment, and the term inside it must NOT be compiled
 *   1  blank
 *   2  a ticket pattern
 *   3  a customer name
 *   4  a line JavaScript cannot compile as a regex
 */
const TERMS = [
  "# widgetco is mentioned here and is not a term",
  "",
  "\\bORBIT-[0-9]+\\b",
  "acmecorp",
  "zeta[q-a]",
].join("\n");

const TICKET_LINE = 2;
const CUSTOMER_LINE = 3;
const UNCOMPILABLE_LINE = 4;

let u: typeof import("../src/understudy.ts");
let store: typeof import("../src/db.ts");

const snapshotFor = (hash: string) =>
  store.db
    .query<{ body: string }, [string]>(`SELECT body FROM understudy_snapshots WHERE hash = ?`)
    .get(hash);

const quarantineFor = (hash: string) =>
  store.db
    .query<{ source_ref: string; class: string; term_index: number }, [string]>(
      `SELECT source_ref, class, term_index FROM understudy_quarantine WHERE source_ref = ?`,
    )
    .get(hash);

beforeAll(async () => {
  u = await import("../src/understudy.ts");
  store = await import("../src/db.ts");
  const file = join(dir, "private-terms.txt");
  writeFileSync(file, TERMS + "\n");
  u.__setUnderstudyStorePath(join(dir, "understudy.json"));
  u.__setPrivateTermsPath(file);
  u.setEnabled(true);
});

describe("the gate reports an index and never a term", () => {
  test("clean text passes", () => {
    expect(u.privateTermsGate("two worktrees open, one of them dirty")).toBe(null);
    expect(u.privateTermsGate("")).toBe(null);
  });

  test("a match returns its line, and nothing else at all", () => {
    const hit = u.privateTermsGate("the fix for ORBIT-1042 finally landed")!;
    expect(hit).not.toBe(null);
    expect(hit.termIndex).toBe(TICKET_LINE);
    // The shape is the promise. One key, a number in it, and no field anywhere
    // on the object that could carry the matched text or an excerpt around it.
    expect(Object.keys(hit)).toEqual(["termIndex"]);
    const asText = JSON.stringify(hit);
    expect(asText).not.toContain("ORBIT");
    expect(asText).not.toContain("1042");
  });

  test("matching is case-insensitive, because a name in a title is the same name", () => {
    expect(u.privateTermsGate("rolled out to AcmeCorp")!.termIndex).toBe(CUSTOMER_LINE);
    expect(u.privateTermsGate("rolled out to acmecorp")!.termIndex).toBe(CUSTOMER_LINE);
  });

  test("a commented line is not a term", () => {
    expect(u.privateTermsGate("widgetco shipped it")).toBe(null);
  });

  test("a line JavaScript cannot compile falls back to a literal rather than being dropped", () => {
    // The file is a list of EXTENDED regexes, and ERE is not quite JavaScript's
    // dialect. A line we cannot compile is a term we promised to catch and
    // silently would not, which is the worst available outcome for this
    // particular file — so it is matched literally instead. That catches the
    // common case, and where it does not it is still more coverage than a skip.
    expect(u.privateTermsGate("a note about zeta[q-a] here")!.termIndex).toBe(UNCOMPILABLE_LINE);
  });

  test("translate replaces the term with its line and leaves the rest alone", () => {
    const out = u.translate("the fix for ORBIT-1042 shipped to acmecorp");
    expect(out).toBe(`the fix for [private:${TICKET_LINE}] shipped to [private:${CUSTOMER_LINE}]`);
    expect(out).not.toContain("ORBIT");
    expect(out).not.toContain("acmecorp");
    // Two different private things stay two different things, so a translated
    // line still reads as a sentence rather than as the same marker twice.
    expect(out).toContain(`[private:${TICKET_LINE}]`);
    expect(out).toContain(`[private:${CUSTOMER_LINE}]`);
  });
});

describe("the seal refuses the body and keeps the row", () => {
  const subject = "pr-4821";
  const body = "reviewing ORBIT-1042 before the merge";
  let id = 0;
  let hash = "";

  test("it does not throw, and the situation is still recorded", () => {
    // The situation genuinely happened. Throwing here would take out the route
    // that was about to answer him, and dropping the row would lose a scored
    // decision because one word in the screen behind it was private.
    expect(() => {
      id = u.sealSituation("C11", { subject, repo: "orbit", partition: "agentglass", body });
    }).not.toThrow();
    expect(id).toBeGreaterThan(0);
    hash = u.__ledgerRow(id)!.situation_hash;
    expect(hash).toHaveLength(64);
  });

  test("the body was never written", () => {
    // The gate runs on the way IN. There is no path where the body is stored
    // first and cleaned up afterwards, because a cleanup that fails leaves the
    // thing we promised never to store sitting on disk.
    expect(snapshotFor(hash)).toBe(null);
  });

  test("the quarantine says that it happened, where, and which line — not what", () => {
    const q = quarantineFor(hash)!;
    expect(q).not.toBe(null);
    expect(q.class).toBe("C11");
    expect(q.term_index).toBe(TICKET_LINE);
    // source_ref is the hash of the WHOLE situation, not of the term, so it is
    // a pointer back to a row rather than a lookup for a short string somebody
    // could enumerate.
    expect(q.source_ref).toBe(hash);
    expect(JSON.stringify(q)).not.toContain("ORBIT");
  });

  test("nothing anywhere in the understudy's tables holds the text", () => {
    // The targeted assertions above prove the columns somebody thought of are
    // clean. This one is about the column nobody thought of: every row of every
    // understudy table, as text, scanned for the term.
    for (const table of [
      "understudy_ledger",
      "understudy_snapshots",
      "understudy_quarantine",
      "understudy_precedents",
    ]) {
      const dump = JSON.stringify(store.db.query(`SELECT * FROM ${table}`).all());
      expect(dump.toLowerCase(), table).not.toContain("orbit-1042");
      expect(dump.toLowerCase(), table).not.toContain("acmecorp");
    }
  });
});

describe("the body is kept for one partition and dropped for the rest", () => {
  test("a clean situation in this repository keeps its body", () => {
    // The negative tests above mean nothing without this one: a seal that never
    // wrote a snapshot for any input would pass all of them.
    const id = u.sealSituation("C11", {
      subject: "pr-4822",
      repo: "agentglass",
      partition: u.OPEN_PARTITION,
      body: "a clean diff and two reviewers",
    });
    const hash = u.__ledgerRow(id)!.situation_hash;
    expect(snapshotFor(hash)!.body).toBe("a clean diff and two reviewers");
    expect(quarantineFor(hash)).toBe(null);
  });

  test("a clean situation anywhere else keeps the hash and drops the body", () => {
    const id = u.sealSituation("C11", {
      subject: "pr-4823",
      repo: "orbit",
      partition: "orbit",
      body: "a diff nobody outside that company should have a copy of",
    });
    const row = u.__ledgerRow(id)!;
    expect(row.situation_hash).toHaveLength(64);
    expect(row.subject).toBe("pr-4823");
    expect(snapshotFor(row.situation_hash)).toBe(null);
    // -1 is the column's documented way of saying the refusal was not a term
    // match at all: nothing was found, the partition simply is not ours.
    expect(quarantineFor(row.situation_hash)!.term_index).toBe(-1);
  });
});

describe("the key a row is filed under is scrubbed, not dropped", () => {
  test("a branch carrying a ticket is stored translated", () => {
    // You cannot drop the key you file under — `subject` is how a later actual
    // finds its seal — so it is scrubbed instead.
    const t0 = Date.now();
    const raw = "feat/ORBIT-1042-rail";
    const id = u.sealSituation("C11", { subject: raw, repo: "orbit", body: "a clean tree", at: t0 });
    const row = u.__ledgerRow(id)!;
    expect(row.subject).toBe(`feat/[private:${TICKET_LINE}]-rail`);
    expect(row.subject).not.toContain("ORBIT");
  });

  test("and the decision that follows still finds it", () => {
    // Scrubbing is deterministic, so the seal and the actual half an hour later
    // produce the same string and still join. If they did not, every branch
    // with a ticket in its name would score as an unsealed decision and the
    // trigger-recall number would be wrong in the direction nobody checks.
    const t0 = Date.now();
    const raw = "feat/ORBIT-1042-join";
    const sealed = u.sealSituation("C11", { subject: raw, repo: "orbit", body: "a clean tree", at: t0 });
    u.recordPrediction(sealed, { branch: "feat/*" }, t0 + 1000);
    const hit = u.recordDecision("C11", {
      subject: raw,
      actual: { branch: "feat/*" },
      provenance: "typed",
      at: t0 + 2000,
    });
    expect(hit).toBe(sealed);
    expect(u.__ledgerRow(sealed)!.verdict).toBe("agree");
    expect(u.__ledgerRow(sealed)!.unsealed).toBe(0);
  });
});

describe("no terms file", () => {
  test("nothing has been declared private, so nothing is", () => {
    u.__setPrivateTermsPath(join(dir, "there-is-no-such-file.txt"));
    expect(u.privateTermsGate("the fix for ORBIT-1042 landed")).toBe(null);
    expect(u.translate("the fix for ORBIT-1042 landed")).toBe("the fix for ORBIT-1042 landed");
    // Put it back, so a file that runs after this one in the same process does
    // not inherit an assumption from the last test in this one.
    u.__setPrivateTermsPath(join(dir, "private-terms.txt"));
    expect(u.privateTermsGate("the fix for ORBIT-1042 landed")!.termIndex).toBe(TICKET_LINE);
  });
});
