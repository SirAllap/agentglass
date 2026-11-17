/*
 * A row's picture is a thumbnail made once per file version, not the file.
 *
 * What went wrong: a 17 px row icon was an `<img>` on the file itself, so a
 * folder of 22 screenshots (0.6 MB each, the widest 4774 by 1072) was fetched
 * whole and decoded at full size for 17 px, and again on every scroll back,
 * because the file route is `no-store` and a virtual row unmounts.
 */
import { describe, expect, test } from "bun:test";
import {
  THUMB_DIRECT_MAX_BYTES, THUMB_EDGES, THUMB_SOURCE_MAX_BYTES,
  containSize, coverSize, makeGate, makeThumbCache, thumbEdge, thumbKey, thumbPlan,
} from "../src/lib/finderThumb.ts";

const thumbSrc = await Bun.file(new URL("../src/components/finder/machine/Thumb.tsx", import.meta.url)).text();
const colSrc = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
const viewsSrc = await Bun.file(new URL("../src/components/finder/machine/FolderViews.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");

describe("the size a thumbnail is made at", () => {
  test("the first step that covers the box on this screen, and never past 2x", () => {
    expect(thumbEdge(17, 1)).toBe(32);
    expect(thumbEdge(17, 1.5)).toBe(32);
    expect(thumbEdge(17, 2)).toBe(64);
    expect(thumbEdge(17, 4)).toBe(64);
    expect(thumbEdge(64, 1.5)).toBe(128);
    expect(thumbEdge(256, 2)).toBe(512);
    expect(thumbEdge(9999, 1)).toBe(THUMB_EDGES[THUMB_EDGES.length - 1]!);
    expect(thumbEdge(17, NaN)).toBe(32);
  });
  test("a wide screenshot is drawn so its SHORT side fills the square", () => {
    expect(coverSize(4774, 1072, 32)).toEqual({ w: 143, h: 32 });
    expect(coverSize(1072, 4774, 32)).toEqual({ w: 32, h: 143 });
  });
  test("a picture smaller than the box is not blown up", () => {
    expect(coverSize(20, 10, 64)).toEqual({ w: 20, h: 10 });
    expect(containSize(20, 10, 64)).toEqual({ w: 20, h: 10 });
  });
  test("a picture shown whole is drawn so its LONG side fits", () => {
    expect(containSize(4774, 1072, 2000)).toEqual({ w: 2000, h: 449 });
  });
  test("a size nobody could read is the square itself, not a zero canvas", () => {
    expect(coverSize(0, 0, 32)).toEqual({ w: 32, h: 32 });
  });
});

describe("the key", () => {
  test("changes with the file's time, its size and the edge, so a saved-over file is a new picture", () => {
    const base = thumbKey("/home/acme/orbit/shot.png", 1000, 600_000, 32);
    expect(thumbKey("/home/acme/orbit/shot.png", 1000, 600_000, 32)).toBe(base);
    expect(thumbKey("/home/acme/orbit/shot.png", 1001, 600_000, 32)).not.toBe(base);
    expect(thumbKey("/home/acme/orbit/shot.png", 1000, 600_001, 32)).not.toBe(base);
    expect(thumbKey("/home/acme/orbit/shot.png", 1000, 600_000, 64)).not.toBe(base);
    expect(thumbKey("/home/acme/orbit/other.png", 1000, 600_000, 32)).not.toBe(base);
  });
});

describe("how a file's picture is drawn", () => {
  test("a screenshot is shrunk", () => {
    expect(thumbPlan("shot.png", 600_000)).toBe("shrink");
    expect(thumbPlan("shot.png", null)).toBe("shrink");
  });
  test("a drawing and a tiny file are used as they are", () => {
    expect(thumbPlan("logo.SVG", 600_000)).toBe("direct");
    expect(thumbPlan("dot.png", THUMB_DIRECT_MAX_BYTES)).toBe("direct");
    expect(thumbPlan("dot.png", THUMB_DIRECT_MAX_BYTES + 1)).toBe("shrink");
  });
  test("a file too large to download for an icon gets its icon", () => {
    expect(thumbPlan("scan.png", THUMB_SOURCE_MAX_BYTES + 1)).toBe("icon");
    expect(thumbPlan("scan.svg", THUMB_SOURCE_MAX_BYTES + 1)).toBe("icon");
  });
});

describe("the cache", () => {
  test("drops the one used longest ago and says which, so its blob can be released", () => {
    const dropped: string[] = [];
    const c = makeThumbCache(2, (u) => dropped.push(u));
    c.set("a", "blob:a"); c.set("b", "blob:b");
    expect(c.get("a")).toBe("blob:a");
    c.set("c", "blob:c");
    expect(dropped).toEqual(["blob:b"]);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("blob:a");
    expect(c.size).toBe(2);
  });
  test("a key written twice releases the first picture", () => {
    const dropped: string[] = [];
    const c = makeThumbCache(2, (u) => dropped.push(u));
    c.set("a", "blob:1"); c.set("a", "blob:2");
    expect(dropped).toEqual(["blob:1"]);
    expect(c.get("a")).toBe("blob:2");
  });
});

describe("the line", () => {
  const defer = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

  test("never more than its limit at once, and the newest asked goes first", async () => {
    const gate = makeGate(1);
    const order: string[] = [];
    const first = defer();
    const a = gate(async () => { order.push("a"); await first.p; });
    const b = gate(async () => { order.push("b"); });
    const c = gate(async () => { order.push("c"); });
    expect(order).toEqual(["a"]);
    first.open();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "c", "b"]);
  });
  test("a row that left before its turn never starts", async () => {
    const gate = makeGate(1);
    const first = defer();
    let ran = false;
    const a = gate(() => first.p);
    const leave = new AbortController();
    const b = gate(async () => { ran = true; }, leave.signal);
    leave.abort();
    await expect(b).rejects.toThrow("left before its turn");
    first.open();
    await a;
    await Promise.resolve();
    expect(ran).toBe(false);
  });
  test("one that already started is finished: the next asker reads its result", async () => {
    const gate = makeGate(1);
    const first = defer();
    const leave = new AbortController();
    const a = gate(async () => { await first.p; return "made"; }, leave.signal);
    leave.abort();
    first.open();
    expect(await a).toBe("made");
  });
  test("a failed job frees its place", async () => {
    const gate = makeGate(1);
    await expect(gate(async () => { throw new Error("unreadable"); })).rejects.toThrow("unreadable");
    expect(await gate(async () => 7)).toBe(7);
  });
});

describe("the row draws the thumbnail", () => {
  test("the file itself is the picture only when the plan says so or the window could not shrink it", () => {
    const c = code(thumbSrc);
    expect(c).toContain("thumbUrl(key, api.previewUrl(path), edge, leave.signal)");
    expect(c).toContain('const src = plan === "shrink" && mine?.url ? mine.url : api.previewUrl(path);');
    expect(c.match(/api\.previewUrl\(/g)!.length).toBe(2);
  });
  test("a row that leaves gives up its place in the line", () => {
    expect(code(thumbSrc)).toContain("return () => leave.abort();");
  });
  test("the box is the same while the thumbnail is made, and the picture decodes off the frame", () => {
    const c = code(thumbSrc);
    expect(c).toContain("const box = { width: size, height: size,");
    expect(c).toContain('<span aria-hidden style={{ ...box, display: "block" }} />');
    expect(c).toContain('decoding="async"');
  });
  test("both views tell it which version of the file this is", () => {
    for (const s of [colSrc, viewsSrc]) expect(code(s)).toContain("name={r.name} mtime={r.mtime} bytes={r.bytes}");
  });
});
