import { beforeEach, describe, expect, test } from "bun:test";
import { cardSuggestions, mirrorLinked, readLinks, withLink, writeLinks, type CardMember, type Links } from "../src/lib/prCardPeople.ts";
import { globalStubs } from "./stubGlobal.ts";

// Never guess identities (decision 2026-10-09): a GitHub login is a card person only after the person linked it.
// The tracker's people for acme/orbit, shaped so the old matcher WOULD have found some of them.
const roster = [
  { key: "1", ident: "1", name: "Mara K", email: "mara.k@acme.test" },
  { key: "2", ident: "2", name: "Theo Weber", email: "theo@acme.test", me: true },
  { key: "3", ident: "3", name: "Lena Park" },
  { key: "4", ident: "4", name: "Kofi O" },
];
const keep = (m: CardMember) => m as (typeof roster)[number];

describe("a login on the tracker", () => {
  test("is nobody until it is linked, however well its name or email fits", () => {
    const m = mirrorLinked(["mara-k", "theo", "theo@acme.test", "lp-orbit"], {}, roster, keep);
    expect(m.matched).toEqual([]);
    expect(m.unlinked.map((u) => u.login)).toEqual(["mara-k", "theo", "theo@acme.test", "lp-orbit"]);
  });
  test("is the person it was linked to, whatever the case of the login", () => {
    const links = withLink({}, "Ines-R", { key: "3", ident: "3", name: "Lena Park" });
    const m = mirrorLinked(["ines-r"], links, roster, keep);
    expect(m.matched.map((x) => [x.login, x.member.key])).toEqual([["ines-r", "3"]]);
  });
  test("a link to someone no longer on the tracker's list is stale, and offered again", () => {
    const links = withLink({}, "ines-r", { key: "99", ident: "99", name: "Gone Person" });
    expect(mirrorLinked(["ines-r"], links, roster, keep).unlinked).toEqual([{ login: "ines-r", stale: true }]);
  });
  test("a tracker with no list (found by typing) uses the person as it was confirmed", () => {
    const links = withLink({}, "ines-r", { key: "acc-1", ident: "acc-1", name: "Ines R" });
    const m = mirrorLinked(["ines-r"], links, null, keep);
    expect(m.matched[0]?.member.name).toBe("Ines R");
  });
  test("a team is no person; two logins linked to one person put them on once", () => {
    let links: Links = withLink({}, "mara-k", roster[0]!);
    links = withLink(links, "mk", roster[0]!);
    const m = mirrorLinked(["@acme/qa", "mara-k", "mk"], links, roster, keep);
    expect(m.matched.length).toBe(1);
    expect(m.unlinked).toEqual([]);
  });
  test("unlinking takes the person away and leaves the other links", () => {
    const a = withLink(withLink({}, "a", roster[0]!), "b", roster[1]!);
    const b = withLink(a, "A", null);
    expect(Object.keys(b)).toEqual(["b"]);
    expect(Object.keys(a)).toEqual(["a", "b"]);
  });
});

describe("who the card half offers", () => {
  const onCard = [roster[2]!];
  test("with nothing typed: the card's people, then you, then the rest", () => {
    const s = cardSuggestions({ q: "", onCard, roster, found: [], skip: [], limit: 10 });
    expect(s.map((x) => [x.person.key, x.why])).toEqual([["3", "On the card"], ["2", "You"], ["1", null], ["4", null]]);
  });
  test("never the pull request's author for being the author: there is no such option", () => {
    const s = cardSuggestions({ q: "", onCard: [], roster: roster.slice(0, 1), found: [], skip: [], limit: 10 });
    expect(s.map((x) => x.why)).toEqual([null]);
  });
  test("typed text narrows by name or email, and skips who is already chosen", () => {
    expect(cardSuggestions({ q: "acme", onCard, roster, found: [], skip: ["1"], limit: 10 }).map((x) => x.person.key)).toEqual(["2"]);
    expect(cardSuggestions({ q: "@lena", onCard, roster, found: [], skip: [], limit: 10 }).map((x) => x.why)).toEqual(["On the card"]);
  });
  test("a person found by typing (no roster) is offered once", () => {
    const f = { key: "acc-9", ident: "acc-9", name: "Zed Q" };
    expect(cardSuggestions({ q: "zed", onCard: [], roster: null, found: [f, f], skip: [], limit: 10 }).length).toBe(1);
  });
});

describe("what is remembered", () => {
  const stubGlobal = globalStubs();
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  });
  test("per tracker: a ClickUp link is not a Jira link", () => {
    writeLinks("clickup", withLink({}, "ines-r", roster[0]!));
    expect(Object.keys(readLinks("clickup"))).toEqual(["ines-r"]);
    expect(readLinks("jira")).toEqual({});
  });
  test("an empty set removes the key", () => {
    writeLinks("clickup", withLink({}, "ines-r", roster[0]!));
    writeLinks("clickup", {});
    expect(store.size).toBe(0);
  });
  test("junk in storage is no links, and a malformed entry is dropped alone", () => {
    store.set("agentglass.pr.cardLinks.clickup", "[1,2]");
    expect(readLinks("clickup")).toEqual({});
    store.set("agentglass.pr.cardLinks.clickup", JSON.stringify({ ok: roster[0], bad: { key: 5 } }));
    expect(Object.keys(readLinks("clickup"))).toEqual(["ok"]);
  });
});

/* The picker's contract, asserted against its source (there is no renderer here). */
const ask = await Bun.file(new URL("../src/components/PrAskPicker.tsx", import.meta.url)).text();
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("the card half never finds a person by name or email", () => {
  const a = code(ask);
  test("the old matcher is gone, and so is the Jira lookup of each picked login", () => {
    expect(a).not.toContain("prCardMatch");
    expect(a).not.toContain("matchMember");
    expect(a).not.toContain("mirrorMembers");
    expect(a).not.toContain("Not found on");
    expect(a).not.toContain("jira.people.values");
    expect(a).not.toContain("asked.current");
  });
  test("a login is linked by choosing a person, from a button that names the login", () => {
    expect(a).toContain("`Link ${r.login} to…`");
    expect(a).toContain("setLink(linking, p)");
    expect(a).toContain("setLink(r.login, null)");
  });
  test("'Same people as ...' is drawn only when a picked login has a confirmed person", () => {
    expect(a).toContain("{linkRows.some((r) => r.member) && <button");
  });
  test("nobody is kept on the card because of who wrote the pull request", () => {
    expect(a).not.toContain("keptAuthor");
    expect(a).not.toContain("stays assigned");
  });
});
