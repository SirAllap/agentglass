import { describe, expect, test } from "bun:test";
import { externalPlace } from "../src/lib/finderMiller.ts";

describe("a request from outside (a path clicked in a terminal)", () => {
  test("a file puts the finder in its folder with the file selected", () => {
    expect(externalPlace("/home/u/orbit/docs", { dir: "/home/u/orbit/docs", name: "01-card.png" })).toEqual({ dir: "/home/u/orbit/docs", name: "01-card.png" });
  });
  test("a folder opens that folder with nothing selected", () => {
    expect(externalPlace("/home/u/orbit/docs", null)).toEqual({ dir: "/home/u/orbit/docs", name: null });
  });
  test("a file wanted in another folder than the place is not applied", () => {
    expect(externalPlace("/home/u/orbit", { dir: "/home/u/acme", name: "a.md" })).toEqual({ dir: "/home/u/orbit", name: null });
  });
  test("a trailing slash does not hide the match", () => {
    expect(externalPlace("/home/u/orbit/", { dir: "/home/u/orbit", name: "a.md" }).name).toBe("a.md");
  });
});

describe("the finder reads the request", () => {
  const src = Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url));
  test("the place, the wanted file and the echoed folder go through externalPlace, behind the external guard", async () => {
    const t = await src.text();
    expect(t.match(/externalPlace\(/g)?.length).toBe(3);
    expect(t).toContain("onWanted?.()");
  });
  test("the palette passes the wanted file and forgets it once applied", async () => {
    const t = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();
    expect(t).toContain("wantFile={wantFile} onWanted={() => setWantFile(null)}");
  });
});
