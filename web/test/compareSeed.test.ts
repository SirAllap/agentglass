import { describe, expect, test } from "bun:test";
import { baseOptions, remoteCompareRef } from "../src/lib/compareSeed.ts";

describe("remoteCompareRef", () => {
  test("a remote-only branch compares by its full ref, slash and all", () => {
    expect(remoteCompareRef({ ref: "origin/feat/x" })).toBe("origin/feat/x");
    expect(remoteCompareRef({ ref: "origin/orbit-1042" })).toBe("origin/orbit-1042");
  });
});

describe("baseOptions", () => {
  test("keeps the menu when the base is in it", () => {
    expect(baseOptions(["main", "origin/feat/x"], "origin/feat/x")).toEqual(["main", "origin/feat/x"]);
  });
  test("adds a base the menu does not list, so the select can show it", () => {
    expect(baseOptions(["main"], "feat/x")).toEqual(["feat/x", "main"]);
  });
  test("before the refs arrive the base is the only option", () => {
    expect(baseOptions([], "origin/feat/x")).toEqual(["origin/feat/x"]);
  });
});

describe("the Remotes door", () => {
  test("passes the full ref, not the short name", async () => {
    const src = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
    const at = src.indexOf("const remoteBranchAction = (");
    const body = src.slice(at, src.indexOf("\n  };\n", at));
    expect(body).toContain("setCompareTarget(remoteCompareRef(b))");
    expect(body).not.toContain("setCompareTarget(b.name)");
  });
});
