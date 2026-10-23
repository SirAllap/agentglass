/*
 * The people lists were the whole roster in the order the roster came in, so
 * the few colleagues somebody picks every day were wherever the alphabet put
 * them, and the pull-request search had no way to name one without typing the
 * qualifier by hand. Pinned here: the ranking (count, halved every two weeks),
 * the "@" being typed, what a pick writes into the box, the picker order, and
 * that none of it asks anybody for anything.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal.ts";
import { FREQUENT_MAX, SUGGEST_REST_MAX, applyPick, atToken, loadUse, rankPeople, recordPicks, scoreOf, suggestPeople, withFrequent } from "../src/lib/personUsage.ts";

const stubGlobal = globalStubs();
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16);
const roster = ["acme-dev", "orbit-ana", "orbit-bo", "orbit-cy", "orbit-di", "orbit-ed", "orbit-fay"];

function memory() {
  const m = new Map<string, string>();
  stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
}

describe("ranking people by use", () => {
  it("puts the most picked first and leaves the others in roster order", () => {
    const use = { "orbit-cy": { n: 5, at: NOW }, "orbit-bo": { n: 2, at: NOW } };
    const r = rankPeople(roster, use, NOW);
    expect(r.frequent).toEqual(["orbit-cy", "orbit-bo"]);
    expect(r.rest).toEqual(["acme-dev", "orbit-ana", "orbit-di", "orbit-ed", "orbit-fay"]);
  });
  it("halves a count every two weeks, so a recent few beat an old many", () => {
    const use = { "orbit-ana": { n: 20, at: NOW - 70 * DAY }, "orbit-ed": { n: 3, at: NOW - DAY } };
    expect(rankPeople(roster, use, NOW).frequent[0]).toBe("orbit-ed");
    expect(scoreOf({ n: 8, at: NOW - 14 * DAY }, NOW)).toBeCloseTo(4, 5);
  });
  it("keeps the shortcut short and never invents a login the roster lacks", () => {
    const use = Object.fromEntries([...roster, "gone-dev"].map((l, i) => [l, { n: 10 - i, at: NOW }]));
    const r = rankPeople(roster, use, NOW);
    expect(r.frequent).toHaveLength(FREQUENT_MAX);
    expect(r.frequent).not.toContain("gone-dev");
    expect(r.frequent.length + r.rest.length).toBe(roster.length);
  });
  it("is the roster untouched when nobody has been picked", () => {
    expect(rankPeople(roster, {}, NOW)).toEqual({ frequent: [], rest: roster });
  });
  it("matches logins whatever their case", () => {
    expect(rankPeople(["Orbit-Ana", "orbit-bo"], { "orbit-ana": { n: 1, at: NOW } }, NOW).frequent).toEqual(["Orbit-Ana"]);
  });
});

describe("the @ in the box", () => {
  it("is found only as the last word", () => {
    expect(atToken("@")).toEqual({ token: "", start: 0 });
    expect(atToken("fix login @orb")).toEqual({ token: "orb", start: 10 });
    expect(atToken("@orbit-ana later")).toBeNull();
    expect(atToken("mail@orbit")).toBeNull();
    expect(atToken("")).toBeNull();
  });
  it("narrows as you type, frequent first", () => {
    const use = { "orbit-fay": { n: 4, at: NOW } };
    const s = suggestPeople(roster, use, "orbit", NOW);
    expect(s.frequent).toEqual(["orbit-fay"]);
    expect(s.rest).toEqual(["orbit-ana", "orbit-bo", "orbit-cy", "orbit-di", "orbit-ed"]);
    expect(s.rest).not.toContain("acme-dev");
    expect(suggestPeople(roster, use, "zzz", NOW)).toEqual({ frequent: [], rest: [] });
  });
  it("draws a handful of the rest, never the whole roster, so the avatars fetched stay few", () => {
    const big = Array.from({ length: 300 }, (_, i) => `orbit-${i}`);
    const s = suggestPeople(big, {}, "", NOW);
    expect(s.rest).toHaveLength(SUGGEST_REST_MAX);
    expect(suggestPeople(big, {}, "orbit-29", NOW).rest.length).toBeGreaterThan(0);
  });
  it("a pick writes author:<login> in place of the @word and keeps what came before", () => {
    expect(applyPick("@or", "orbit-ana")).toBe("author:orbit-ana ");
    expect(applyPick("is:open @", "acme-dev")).toBe("is:open author:acme-dev ");
  });
});

describe("what is remembered", () => {
  it("counts every pick, survives a reload and ignores a broken value", () => {
    const m = memory();
    recordPicks(["Orbit-Ana", "orbit-bo"], NOW - DAY);
    recordPicks(["orbit-ana"], NOW);
    const use = loadUse();
    expect(use["orbit-ana"]).toEqual({ n: 2, at: NOW });
    expect(use["orbit-bo"]!.n).toBe(1);
    m.set("agentglass.pr.people", "[1,2");
    expect(loadUse()).toEqual({});
    m.set("agentglass.pr.people", JSON.stringify({ x: { n: "a", at: 1 } }));
    expect(loadUse()).toEqual({});
  });
  it("stays usable with storage refusing", () => {
    stubGlobal("localStorage", { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); } });
    expect(loadUse()).toEqual({});
    expect(() => recordPicks(["orbit-ana"])).not.toThrow();
  });
});

describe("the reviewer and assignee pickers", () => {
  const opts = roster.map((l) => ({ value: l, label: l, ...(l === "orbit-bo" ? { sub: "approved 2d ago" } : null) }));
  it("lift the frequent into a top section and keep each option's own line", () => {
    const out = withFrequent(opts, { "orbit-bo": { n: 3, at: NOW }, "orbit-ed": { n: 1, at: NOW } }, NOW);
    expect(out.map((o) => o.value).slice(0, 2)).toEqual(["orbit-bo", "orbit-ed"]);
    expect(out[0]!.section).toBe("Frequent");
    expect(out[0]!.sub).toBe("approved 2d ago");
    expect(out.slice(2).every((o) => o.section === "Everyone")).toBe(true);
    expect(out).toHaveLength(opts.length);
  });
  it("come back untouched, with no headers, when nobody is frequent", () => {
    const out = withFrequent(opts, {}, NOW);
    expect(out).toEqual(opts);
    expect(out.some((o) => "section" in o)).toBe(false);
  });
});

describe("typing @ asks nobody for anything", () => {
  const bar = readFileSync(new URL("../src/components/PrFilterBar.tsx", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src/lib/personUsage.ts", import.meta.url), "utf8");
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  it("the bar and the ranking have no request in them", () => {
    for (const src of [code(bar), code(lib)]) {
      expect(src).not.toMatch(/\bfetch\(|api\.|XMLHttpRequest|useEffect/);
    }
  });
  it("the panel hands the bar the people it already loaded", () => {
    const panel = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain("people={mentions?.users ?? null}");
    expect(panel.match(/api\.prMentions\(/g)!.length).toBe(2);
  });
});
