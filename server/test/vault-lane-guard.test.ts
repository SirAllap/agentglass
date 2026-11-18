/*
 * Decision F7: in a lane signed in from the login vault, the verbs that could
 * read the login back out are refused; acting and reading the page are not.
 */
import { describe, expect, it } from "bun:test";
import { forgetVaultLane, isVaultLane, markVaultLane, vaultLaneRefusal } from "../src/browserdrive.ts";

describe("vault lane guard", () => {
  it("refuses read-back verbs only in a marked lane", () => {
    expect(vaultLaneRefusal("eval", "lane-a")).toBeNull();
    markVaultLane("lane-a");
    expect(isVaultLane("lane-a")).toBe(true);
    for (const op of ["eval", "waitfor", "cookies", "storage", "har", "headers", "network", "cdp"]) {
      expect(vaultLaneRefusal(op, "lane-a")).toContain("login vault");
    }
    for (const op of ["click", "fill", "read", "markdown", "shot", "open"]) expect(vaultLaneRefusal(op, "lane-a")).toBeNull();
    expect(vaultLaneRefusal("eval", "lane-b")).toBeNull();
    expect(vaultLaneRefusal("eval", undefined)).toBeNull();
    forgetVaultLane("lane-a");
    expect(vaultLaneRefusal("eval", "lane-a")).toBeNull();
  });
});
