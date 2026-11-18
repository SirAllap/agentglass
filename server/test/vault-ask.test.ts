/*
 * The person's OK for a sensitive vault pull is Electron main's: its own
 * dialog, reported on main's own key. The window's desk key, an agent, or a
 * made-up yes is refused. Names are invented; no cookie value exists here.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { resetVaultAsks, takeVaultGrant, vaultOkDoor } from "../src/vaultAsk.ts";

afterEach(() => resetVaultAsks());
const KEY = "main-key-fake-0001";
const pull = { lane: "lane_1", site: "billing.acme.test", agent: "builder-7" };

describe("main's OK for a sensitive pull", () => {
  it("main's key grants once, for its own lane and site", () => {
    expect(vaultOkDoor({ main: KEY, agent: false }, pull, KEY)).toEqual({ status: 200, body: { ok: true } });
    expect(takeVaultGrant("lane_9", "billing.acme.test")).toBe(false);
    expect(takeVaultGrant("lane_1", "orbit.test")).toBe(false);
    expect(takeVaultGrant("lane_1", "billing.acme.test")).toBe(true);
    expect(takeVaultGrant("lane_1", "billing.acme.test")).toBe(false);
  });
  it("a yes sent by the renderer (desk key only, no main key) is refused", () => {
    const r = vaultOkDoor({ main: "", agent: false }, pull, KEY);
    expect(r.status).toBe(403);
    expect(takeVaultGrant("lane_1", "billing.acme.test")).toBe(false);
  });
  it("a wrong key, an agent, or a server with no main key is refused", () => {
    expect(vaultOkDoor({ main: "made-up", agent: false }, pull, KEY).status).toBe(403);
    expect(vaultOkDoor({ main: KEY, agent: true }, pull, KEY).status).toBe(403);
    expect(vaultOkDoor({ main: "", agent: false }, pull, "").status).toBe(403);
    expect(vaultOkDoor({ main: "x", agent: false }, pull, "").status).toBe(403);
    expect(takeVaultGrant("lane_1", "billing.acme.test")).toBe(false);
  });
  it("a grant goes stale after six minutes", () => {
    vaultOkDoor({ main: KEY, agent: false }, pull, KEY, 0);
    expect(takeVaultGrant("lane_1", "billing.acme.test", 6 * 60_000 + 1)).toBe(false);
  });
});
