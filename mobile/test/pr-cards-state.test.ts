import { describe, expect, test } from "bun:test";
import { forgetPrCards, lookupsFor } from "../src/state/pr-cards.ts";
import type { Host } from "../src/lib/host.ts";

const host = (token: string): Host =>
  ({ origin: "http://192.168.1.20:4000", token, label: "orbit phone", scope: "full" }) as unknown as Host;

describe("the card lookup tables", () => {
  test("a re-paired phone (same computer, new token) gets its own table, not the one holding the old token", () => {
    expect(lookupsFor(host("old"))).toBe(lookupsFor(host("old")));
    expect(lookupsFor(host("new"))).not.toBe(lookupsFor(host("old")));
  });

  test("forgetting clears the table of that host's token", () => {
    const l = lookupsFor(host("t1"));
    let cleared = 0;
    const was = l.clear;
    l.clear = () => { cleared++; was.call(l); };
    forgetPrCards(host("t1"));
    expect(cleared).toBe(1);
  });
});
