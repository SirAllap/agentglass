/*
 * The pairs a person makes by doing both picks on one card: a GitHub reviewer,
 * and the Jira account put on the card with them. Local, on this machine.
 *
 * What a mistake here costs: a card assigned to a stranger because two accounts
 * shared a name, or a pair that outlives the person's correction. So only the
 * account id is compared, and a newer pick replaces an older one.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-pairs-"));
const file = join(dir, "jira-pairs.json");
const P = await import("../src/jiraPairs.ts");
P.__setPairsPath(file);

afterAll(() => { P.__setPairsPath(null); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => rmSync(file, { force: true }));

/** Learn, and fail the test by name when the store refused. */
const learn = (picks: Parameters<typeof P.learnPairs>[0]) => {
  const r = P.learnPairs(picks);
  if (!r.ok) throw new Error(r.error);
  return r.pairs;
};

describe("the pairs this machine learned", () => {
  test("a pair survives a reload: it is read back from the file, not from memory", () => {
    P.learnPairs([{ login: "adadev", accountId: "acct-123", name: "Ada Dev", email: "ada@acme.test" }]);
    // The module holds nothing: `readPairs` is the file.
    const rows = Object.values(P.readPairs());
    expect(rows).toEqual([{ login: "adadev", accountId: "acct-123", name: "Ada Dev", email: "ada@acme.test", n: 1, at: expect.any(Number) }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ adadev: { accountId: "acct-123" } });
  });

  test("two picks of the same pair rank it higher than one", () => {
    learn([{ login: "adadev", accountId: "acct-123", name: "Ada Dev" }]);
    learn([{ login: "lin", accountId: "acct-900", name: "Lin Tester" }]);
    const both = learn([{ login: "adadev", accountId: "acct-123", name: "Ada Dev" }]);
    expect(both.adadev!.n).toBe(2);
    expect(both.lin!.n).toBe(1);
    expect(P.pairsFor(both, ["adadev", "lin"]).map((p) => p.accountId)).toEqual(["acct-123", "acct-900"]);
  });

  test("a newer pick for the same login wins over the older account", () => {
    learn([{ login: "adadev", accountId: "acct-123", name: "Ada Dev" }]);
    learn([{ login: "adadev", accountId: "acct-999", name: "Ada Dev (new site)" }]);
    const rows = Object.values(P.readPairs());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: "acct-999", name: "Ada Dev (new site)", n: 1 });
  });

  test("removing a pair drops it, and only it", () => {
    learn([
      { login: "adadev", accountId: "acct-123", name: "Ada Dev" },
      { login: "lin", accountId: "acct-900", name: "Lin Tester" },
    ]);
    const left = Object.values(P.forgetPair("AdaDev"));
    expect(left.map((p) => p.login)).toEqual(["lin"]);
    expect(Object.keys(P.readPairs())).toEqual(["lin"]);
  });

  test("a pair is looked up by the logins at hand, case-folded, and teams are not logins", () => {
    const pairs = learn([{ login: "adadev", accountId: "acct-123", name: "Ada Dev" }]);
    expect(P.pairsFor(pairs, ["AdaDev"]).map((p) => p.accountId)).toEqual(["acct-123"]);
    expect(P.pairsFor(pairs, ["@acme/reviewers"])).toEqual([]);
    expect(P.pairsFor(pairs, ["lin"])).toEqual([]);
  });

  test("an entry written by hand without an account id is dropped, never repaired", () => {
    writeFileSync(file, JSON.stringify({ adadev: { name: "Ada Dev", n: 3, at: 1 }, lin: { accountId: "acct-900", name: "Lin Tester", n: 1, at: 2 } }));
    expect(Object.keys(P.readPairs())).toEqual(["lin"]);
    // A name and an email are not a pair, whichever field they sit in.
    writeFileSync(file, JSON.stringify({ adadev: { name: "Ada Dev", email: "ada@acme.test" } }));
    expect(P.readPairs()).toEqual({});
  });

  test("a file somebody broke by hand is refused, not rebuilt from empty", () => {
    const broken = '{\n  "adadev": { "accountId": "acct-123", "name": "Ada Dev", },\n';
    writeFileSync(file, broken);
    const r = P.learnPairs([{ login: "lin", accountId: "acct-900", name: "Lin Tester" }]);
    expect(r.ok).toBe(false);
    // The pairs are still in there, exactly as they were: one learn does not replace them with itself.
    expect(readFileSync(file, "utf8")).toBe(broken);
    expect(readdirSync(dir)).toEqual(["jira-pairs.json"]);
  });

  test("a write replaces the file whole, so nobody reads it half-written", () => {
    learn([{ login: "adadev", accountId: "acct-123", name: "Ada Dev" }]);
    const before = statSync(file).ino;
    learn([{ login: "lin", accountId: "acct-900", name: "Lin Tester" }]);
    // A rename puts a new file in place; a truncate-and-write keeps the same one.
    expect(statSync(file).ino).not.toBe(before);
    expect(readdirSync(dir)).toEqual(["jira-pairs.json"]);
    expect(Object.keys(P.readPairs())).toEqual(["adadev", "lin"]);
  });
});
