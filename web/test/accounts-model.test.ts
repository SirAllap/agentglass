import { describe, expect, test } from "bun:test";
import { accountNameProblem, hasChoice, identityLine, repoOptions, repoRows, type AccountRow } from "../src/lib/accountsModel.ts";

const work: AccountRow = { accountKey: "work", isDefault: true, site: "orbit-demo.example", email: "alex@orbit.example" };
const personal: AccountRow = { accountKey: "personal", isDefault: false, workspace: "Side", account: "Alex P" };

describe("accountNameProblem", () => {
  test("accepts a fresh name", () => expect(accountNameProblem(" staging ", [work])).toBeNull());
  test.each([["", /short name/], ["primary", /kept for the first/], ["Has Space", /lower-case/], ["work", /already have/]])("refuses %p", (n, re) =>
    expect(accountNameProblem(n, [work])).toMatch(re));
});

describe("identityLine / hasChoice", () => {
  test("site and email, else workspace and account, else a plain word", () => {
    expect(identityLine(work)).toBe("orbit-demo.example · alex@orbit.example");
    expect(identityLine(personal)).toBe("Side · Alex P");
    expect(identityLine({ accountKey: "x", isDefault: false })).toBe("Connected");
  });
  test("a choice needs two accounts", () => { expect(hasChoice([work])).toBe(false); expect(hasChoice([work, personal])).toBe(true); });
});

describe("repoRows", () => {
  const map = { "acme/docs": { clickup: "personal" }, "acme/old-site": { clickup: "staging" }, "acme/other": { jira: "work" } };
  const rows = repoRows(["acme/orbit", "Acme/Docs", "acme/old-site"], map, "clickup", [work, personal]);
  test("chosen repos first, then the rest by name; another provider's choice is not this one's", () =>
    expect(rows.map((r) => r.repo)).toEqual(["acme/docs", "acme/old-site", "acme/orbit"]));
  test("a removed account keeps its name, says so, and the default is named", () => {
    const r = rows.find((x) => x.repo === "acme/old-site")!;
    expect([r.removed, r.value]).toEqual([true, "staging"]);
    expect(r.note).toBe("Mapped to “staging”, which no longer exists. Uses the default (work) until you pick one.");
  });
  test("no entry follows the default and has no note", () => expect(rows.find((x) => x.repo === "acme/orbit")).toMatchObject({ value: "", removed: false, note: null }));
  test("options: Default (name) first, every account, the removed one last", () => {
    expect(repoOptions(rows[1]!, [work, personal]).map((o) => o.label)).toEqual(["Default (work)", "work", "personal", "staging (removed)"]);
  });
});
