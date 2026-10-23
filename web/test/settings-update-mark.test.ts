/*
 * The About mark in the nav and the page header comes from the same answer the
 * page itself reads. The server sets `available: true` for "no releases
 * published" and for a blocked check as well, so reading `available` alone
 * painted "Update available" over a page that said "Up to date".
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { stubStorage } from "./stubStorage.ts";
import type { UpdateStatus } from "../../shared/types.ts";

const stubGlobal = globalStubs();
stubStorage({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
let isUpdateAvailable: typeof import("../src/lib/updateStore.ts")["isUpdateAvailable"];
beforeAll(async () => {
  stubGlobal("location", new URL("http://localhost:5173/"));
  ({ isUpdateAvailable } = await import("../src/lib/updateStore.ts"));
});

const st = (o: Partial<UpdateStatus>) => ({ ok: true, available: false, branch: "", behind: 0, ahead: 0, incoming: [], ...o }) as UpdateStatus;
const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();

describe("About's update mark", () => {
  test("a newer release is an update; blocked, current or unknown are not", () => {
    expect(isUpdateAvailable(st({ available: true, branch: "v1.2.0", behind: 1 }))).toBe(true);
    expect(isUpdateAvailable(st({ available: true, branch: "v1.2.0", behind: 0 }))).toBe(false);
    expect(isUpdateAvailable(st({ available: true, behind: 1, blocked: "no releases published yet" }))).toBe(false);
    expect(isUpdateAvailable(st({ ok: false, available: true, behind: 1 }))).toBe(false);
    expect(isUpdateAvailable(null)).toBe(false);
  });
  test("the nav fact reads that answer, not the bare `available` flag", () => {
    const line = src.split("\n").find((l) => l.includes("api.updateStatus().then")) ?? "";
    expect(line).toContain("isUpdateAvailable(r)");
    expect(line).not.toContain("r.available");
  });
});
