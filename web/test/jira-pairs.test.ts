/*
 * Which Jira account a picker offers first: only one this machine saw the person
 * pick alongside that GitHub login. A login and an account that share a name, or
 * an email, are two people until the person says otherwise.
 */
import { describe, expect, test } from "bun:test";
import { pairPick, pairRows, pairedFirst } from "../src/lib/jiraPairs.ts";
import type { JiraPair } from "../../shared/providers.ts";

const person = (id: string, name: string, email?: string) => ({ id, key: id, name, ...(email ? { email } : null) });
const pair = (login: string, accountId: string, name: string, n = 1, at = 1): JiraPair => ({ login, accountId, name, n, at });

const adadev = person("acct-123", "Ada Dev", "ada@acme.test");
const lin = person("acct-900", "Lin Tester", "lin@acme.test");
const orphan = person("acct-404", "Nobody Known");

describe("the Jira account a login is, offered first", () => {
  test("a pair learned from (reviewer adadev, Jira acct-123) lifts acct-123 above the rest", () => {
    const rows = pairedFirst([lin, orphan, adadev], { logins: ["adadev"], pairs: [pair("adadev", "acct-123", "Ada Dev")] });
    expect(rows.map((p) => p.id)).toEqual(["acct-123", "acct-900", "acct-404"]);
  });

  test("a name and an email that match are not a pair: the order does not move", () => {
    // adadev's account is not in the machine's pairs; the row with the same name
    // and the same email is still an ordinary row.
    const rows = pairedFirst([lin, adadev], { logins: ["adadev"], pairs: [] });
    expect(rows.map((p) => p.id)).toEqual(["acct-900", "acct-123"]);
  });

  test("a pair for another login never lifts a row", () => {
    const rows = pairedFirst([lin, adadev], { logins: ["adadev"], pairs: [pair("someone-else", "acct-123", "Ada Dev")] });
    expect(rows.map((p) => p.id)).toEqual(["acct-900", "acct-123"]);
  });

  test("the most-picked pair comes first, and the newer of two equally picked", () => {
    const a = person("acct-1", "One");
    const b = person("acct-2", "Two");
    const c = person("acct-3", "Three");
    const pairs = [pair("x", "acct-1", "One", 1, 50), pair("y", "acct-2", "Two", 3, 10), pair("z", "acct-3", "Three", 1, 90)];
    const rows = pairedFirst([a, b, c], { logins: ["x", "y", "z"], pairs });
    expect(rows.map((p) => p.id)).toEqual(["acct-2", "acct-3", "acct-1"]);
  });

  test("a Data Center account is lifted by the key a write takes, not by the card id", () => {
    // findMe: the card carries the account id, a write takes the login.
    const dc = { id: "acc-0003", key: "lin", name: "Lin Tester" };
    const rows = pairedFirst([adadev, dc], { logins: ["adadev"], pairs: [pair("adadev", "lin", "Lin Tester")] });
    expect(rows.map((p) => p.key)).toEqual(["lin", "acct-123"]);
  });

  test("teams are not logins, and a login's case is not:", () => {
    const rows = pairedFirst([lin, adadev], { logins: ["@acme/reviewers", "AdaDev"], pairs: [pair("adadev", "acct-123", "Ada Dev")] });
    expect(rows.map((p) => p.id)).toEqual(["acct-123", "acct-900"]);
  });
});

describe("the pair one errand makes", () => {
  const who = { key: "acct-123", name: "Ada Dev", email: "ada@acme.test" };

  test("one login picked alongside one account is a pair", () => {
    expect(pairPick(["adadev"], who)).toEqual([{ login: "adadev", accountId: "acct-123", name: "Ada Dev", email: "ada@acme.test" }]);
  });

  test("two logins and one account are not: neither reviewer becomes the person the card went to", () => {
    // A hand-over asks alice and bob for a review and gives the card to bob: alice is not bob.
    expect(pairPick(["alice", "bob"], who)).toEqual([]);
    expect(pairPick(["alice", "bob"], { key: "acct-123", name: "Bob" })).toEqual([]);
  });

  test("a team is not a login, so picking one beside a login leaves the login alone", () => {
    expect(pairPick(["@acme/reviewers", "adadev"], who).map((p) => p.login)).toEqual(["adadev"]);
    expect(pairPick(["@acme/reviewers"], who)).toEqual([]);
  });
});

describe("the paired account as a row", () => {
  test("a pair builds the row itself: with nothing typed, nothing else knows the account exists", () => {
    const rows = pairRows(["adadev"], [pair("adadev", "acct-123", "Ada Dev")]);
    expect(rows).toEqual([{ id: "acct-123", key: "acct-123", ident: "acct-123", name: "Ada Dev" }]);
  });

  test("only the logins this picker picked, and the most-picked account first", () => {
    const pairs = [pair("bob", "acct-2", "Bob B", 1, 10), pair("alice", "acct-1", "Alice A", 3, 5), pair("carol", "acct-3", "Carol C")];
    expect(pairRows(["alice", "bob"], pairs).map((p) => p.key)).toEqual(["acct-1", "acct-2"]);
    expect(pairRows(["@acme/reviewers"], pairs)).toEqual([]);
  });
});
