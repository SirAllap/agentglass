/*
 * `lane vault`: the agent names a lane and a site, never a value. The OK for
 * a sensitive site is Electron main's own dialog, so nothing here sends one.
 */
import { describe, expect, it } from "bun:test";
import { parseAsk } from "../src/browserdrive.ts";

describe("lane vault parse", () => {
  it("takes a lane id and one site, folded", () => {
    const r = parseAsk("lane", { action: "vault", id: "lane_1", site: " Acme.TEST " });
    expect("ask" in r && r.ask.args).toMatchObject({ action: "vault", id: "lane_1", site: "acme.test" });
  });
  it("refuses a missing lane, a bad site, an empty vault name", () => {
    expect(parseAsk("lane", { action: "vault", site: "acme.test" })).toEqual({ error: "vault needs the lane id" });
    expect("error" in parseAsk("lane", { action: "vault", id: "lane_1", site: "acme.test/x" })).toBe(true);
    expect("error" in parseAsk("lane", { action: "vault", id: "lane_1", site: "acme.test", vault: " " })).toBe(true);
  });
  it("sends no approval flag, whatever the caller adds", () => {
    const r = parseAsk("lane", { action: "vault", id: "lane_1", site: "acme.test", approved: true });
    expect("ask" in r && r.ask.args.approved).toBeUndefined();
  });
  it("carries a named vault", () => {
    const r = parseAsk("lane", { action: "vault", id: "lane_1", site: "acme.test", vault: "zen:abc/1" });
    expect("ask" in r && r.ask.args.vault).toBe("zen:abc/1");
  });
});
