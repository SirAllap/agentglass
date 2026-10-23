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

describe("reopening where it was left", () => {
  test("the folder echoed back by the path field changes nothing when the finder is already in it", async () => {
    const { folderTargetMove } = await import("../src/lib/finderMiller.ts");
    expect(folderTargetMove("/home/u/orbit", "/home/u/orbit", null)).toBe("stay");
    expect(folderTargetMove("/home/u/orbit/", "/home/u/orbit", null)).toBe("stay");
  });
  test("a file in the folder it is already in, or any other folder, still moves", async () => {
    const { folderTargetMove } = await import("../src/lib/finderMiller.ts");
    expect(folderTargetMove("/home/u/orbit", "/home/u/orbit", "a.md")).toEqual({ dir: "/home/u/orbit", name: "a.md" });
    expect(folderTargetMove("/home/u/orbit", "/home/u/acme", null)).toEqual({ dir: "/home/u/acme", name: null });
  });
  test("the target effect asks folderTargetMove before it clears the selection", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(t).toContain("folderTargetMove(trailRef.current[0]!, at, file)");
  });
  test("the snapshot keeps the preview view of the selected file", async () => {
    const { readMachineSnap, writeMachineSnap } = await import("../src/lib/finderMachineState.ts");
    const snap = { v: 1 as const, trail: ["/home/u/orbit"], sel: ["a.md"], focusCol: 0, scroll: {}, dragged: {}, peek: false, previewTab: { path: "/home/u/orbit/a.md", tab: "Source" } };
    expect(readMachineSnap(writeMachineSnap(snap))?.previewTab).toEqual(snap.previewTab);
    expect(readMachineSnap(writeMachineSnap({ ...snap, previewTab: { path: "rel", tab: "Source" } }))?.previewTab).toBeUndefined();
  });
});
