import { describe, expect, test } from "bun:test";
import { browserOffReason, flowRoleBrowserAllowed, type BrowserWorkers } from "../../shared/browserWorkers.ts";

/* A custom flow role with no base role gets no browser credential: the note a
   worker reads says "no browser", so the code must not fall back to builder. */
const set: BrowserWorkers = { engines: ["claude"], roles: ["builder"], flowRoles: {}, seat: true, cardTabs: true };
const ask = (base: string, id = "ops") => ({ flowRole: { root: "/r", id, title: "Ops", base } });

describe("flow role with no base", () => {
  test("no base: refused", () => {
    expect(browserOffReason(set, "claude", "ops", ask(""))).not.toBeNull();
    expect(flowRoleBrowserAllowed(set, "/r", "ops", "")).toBe(false);
  });
  test("no base: refused even with an explicit row on", () => {
    const on = { ...set, flowRoles: { "/r": { ops: true } } };
    expect(flowRoleBrowserAllowed(on, "/r", "ops", "")).toBe(false);
  });
  test("base builder: still allowed", () => {
    expect(browserOffReason(set, "claude", "ops", ask("builder"))).toBeNull();
  });
});
