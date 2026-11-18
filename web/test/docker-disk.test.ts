/*
 * "How much can come back", from the same images the Images view lists.
 *
 * The numbers here are promises: a total that says 9 GB can come back and frees
 * 6 is worse than no total. So the bar, the legend and the three cards all read
 * from one function, and data volumes are not an input to any of the sums.
 */
import { describe, expect, test } from "bun:test";
import type { DockerDisk, DockerImage } from "../../shared/types.ts";
import { BUILD_CACHE_BUDGET, diskMath, imageBytes, orphanUniqueBytes } from "../src/lib/dockerDisk.ts";
import { imagesView } from "../src/lib/dockerResources.ts";

const disk = (over: Partial<DockerDisk> = {}): DockerDisk => ({
  images: 4_000_000_000, containers: 300_000_000, volumes: 3_000_000_000, buildCache: 8_000_000_000,
  reclaimable: 0, orphans: [], volumes_: [], at: 0, ...over,
});
const img = (id: string, size: string, over: Partial<DockerImage> = {}): DockerImage => ({
  id, repository: "acme/orbit-api", tag: "dev", size, created: "3 hours ago", containers: "0", dangling: false, ...over,
});
const gone = (tag: string, bytes: number | null) => ({ id: tag, tag, bytes, worktree: "billing-fix" });
const GB = 1e9;
/* The mockup keeps a 5 GB budget; the app's own is larger. The maths is the same. */
const B = 5 * GB;
const dm = (d: DockerDisk, images: DockerImage[]) => diskMath(d, images, B);

describe("an image's size", () => {
  test("is docker's own words turned back into bytes", () => {
    expect(imageBytes(img("a", "780MB"))).toBe(780_000_000);
    expect(imageBytes(img("a", "1.2GB"))).toBe(1_200_000_000);
  });
  test("is zero when docker did not say, so a sum cannot be NaN", () => {
    expect(imageBytes(img("a", ""))).toBe(0);
    expect(imageBytes(img("a", "N/A"))).toBe(0);
  });
});

describe("what can come back", () => {
  test("is the cache over budget, the worktree-gone images and the dangling ones, and nothing else", () => {
    const d = dm(disk({ orphans: [gone("acme/orbit-api:old", 0.8 * GB)] }), [img("d1", "200MB", { repository: "<none>", dangling: true })]);
    expect(d.cacheOver).toBe(8 * GB - B);
    expect(d.orphanBytes).toBe(0.8 * GB);
    expect(d.danglingBytes).toBe(0.2 * GB);
    expect(d.back).toBe(d.cacheOver + 0.8 * GB + 0.2 * GB);
  });

  test("never counts volumes, however big", () => {
    const small = dm(disk({ volumes: 1 * GB }), []);
    const huge = dm(disk({ volumes: 900 * GB }), []);
    expect(huge.back).toBe(small.back);
    expect(huge.legend.find((l) => l.key === "volumes")!.canGo).toBe(0);
    expect(huge.legend.find((l) => l.key === "volumes")!.note).toBe("kept");
  });

  test("a cache under the budget gives nothing back and says so", () => {
    const d = dm(disk({ buildCache: 4 * GB }), []);
    expect(d.cacheOver).toBe(0);
    expect(d.underBudget).toBe(true);
    expect(d.legend.find((l) => l.key === "cache")!.note).toBe("under the budget");
  });

  test("nothing to give back reads as zero, not as an absent field", () => {
    const d = dm(disk({ buildCache: 1 * GB }), []);
    expect(d.back).toBe(0);
  });

  test("an orphan whose size is unknown counts as zero bytes but still as an image", () => {
    const d = dm(disk({ orphans: [gone("acme/orbit-api:old", null)] }), []);
    expect(d.orphanBytes).toBe(0);
    expect(d.orphanCount).toBe(1);
  });
});

describe("the bar", () => {
  const d = dm(disk({ orphans: [gone("a:old", 0.8 * GB)] }), [img("d1", "200MB", { repository: "<none>", dangling: true })]);

  test("its segments add up to exactly the total, so it never overflows", () => {
    expect(d.total).toBe(4 * GB + 0.3 * GB + 3 * GB + 8 * GB);
    expect(d.segments.reduce((n, s) => n + s.bytes, 0)).toBe(d.total);
  });

  test("the striped ones are the things that can go, and only those", () => {
    expect(d.segments.filter((s) => s.stripe).map((s) => s.key)).toEqual(["orphans", "dangling", "cache-over"]);
    expect(d.segments.filter((s) => s.stripe).reduce((n, s) => n + s.bytes, 0)).toBe(d.back);
  });

  test("a zero segment is left out", () => {
    const e = dm(disk({ buildCache: 1 * GB }), []);
    expect(e.segments.every((s) => s.bytes > 0)).toBe(true);
    expect(e.segments.some((s) => s.stripe)).toBe(false);
  });

  /* `docker images` counts a shared layer once per image, so the pieces can
     add up to more than the daemon's own images figure. The bar caps them at
     it: a segment wider than its slice would push the others off the end. */
  test("orphans and dangling cannot add up to more than the images slice", () => {
    const e = dm(disk({ images: 1 * GB, orphans: [gone("a:old", 0.9 * GB)] }), [img("d1", "600MB", { dangling: true })]);
    expect(e.orphanBytes + e.danglingBytes).toBeLessThanOrEqual(1 * GB);
    expect(e.segments.reduce((n, s) => n + s.bytes, 0)).toBe(e.total);
    expect(e.back).toBe(e.cacheOver + e.orphanBytes + e.danglingBytes);
  });
});

describe("the legend", () => {
  test("four rows, with how much of each can go", () => {
    const d = dm(disk({ orphans: [gone("a:old", 0.8 * GB)] }), []);
    expect(d.legend.map((l) => l.key)).toEqual(["images", "cache", "volumes", "containers"]);
    expect(d.legend[0]!.canGo).toBe(0.8 * GB);
  });

  /* The repro: `docker system df` says 58 images, 41.24 GB, 15.35 GB
     reclaimable. Only one image in that 15.35 GB is an orphan (worktree
     gone) or dangling — the rest are plain idle images, reclaimable too but
     invisible to the orphan/dangling lists. Before this fix the legend's
     "images" row showed only the orphan+dangling slice (0.8 GB here), which
     is a different, smaller number than the Images header's own "unused"
     (`imageReclaimable`, from the same `system df`) — the two views
     disagreeing about the same daemon. */
  test("'images, can go' is the daemon's own imageReclaimable, not just the orphan+dangling rows", () => {
    const d = dm(disk({ orphans: [gone("a:old", 0.8 * GB)], imageReclaimable: 15.35 * GB }), []);
    expect(d.legend[0]!.canGo).toBe(15.35 * GB);
    expect(d.legend[0]!.canGo).not.toBe(d.orphanBytes + d.danglingBytes);
  });

  test("without imageReclaimable (older fixture, or the first paint): falls back to orphan+dangling, same as before", () => {
    const d = dm(disk({ orphans: [gone("a:old", 0.8 * GB)] }), [img("d1", "200MB", { dangling: true })]);
    expect(d.legend[0]!.canGo).toBe(d.orphanBytes + d.danglingBytes);
  });
});

describe("the three reclaim cards", () => {
  test("cache, worktree-gone images, dangling images, in that order", () => {
    const d = dm(disk({ orphans: [gone("a:old", 0.8 * GB), gone("b:old", 0.1 * GB)] }), [img("d1", "200MB", { dangling: true })]);
    expect(d.cards.map((c) => c.key)).toEqual(["cache", "orph", "dang"]);
    expect(d.cards.map((c) => c.count)).toEqual([null, 2, 1]);
    expect(d.cards.map((c) => c.none)).toEqual([false, false, false]);
    expect(d.cards[1]!.frees).toBe(0.9 * GB);
  });

  test("a card with nothing to do is marked none, so the button says so", () => {
    const d = dm(disk({ buildCache: 1 * GB }), []);
    expect(d.cards.every((c) => c.none)).toBe(true);
  });

  test("the button names the count in the right number", () => {
    const one = dm(disk(), [img("d1", "200MB", { dangling: true })]);
    expect(one.cards[2]!.label).toBe("Remove 1 image");
    const two = dm(disk(), [img("d1", "1MB", { dangling: true }), img("d2", "1MB", { dangling: true })]);
    expect(two.cards[2]!.label).toBe("Remove 2 images");
  });

  test("the cache card names what it frees", () => {
    expect(dm(disk(), []).cards[0]!.label).toBe("Free 3.0 GB");
  });

  test("volumes have no card at all", () => {
    expect(dm(disk(), []).cards.map((c) => c.key)).not.toContain("vol");
  });
});

describe("the sentence under the total", () => {
  test("says how much can come back, or that nothing can", () => {
    expect(dm(disk(), []).backText).toBe("3.0 GB can come back");
    expect(dm(disk({ buildCache: 1 * GB }), []).backText).toBe("Nothing to give back right now");
  });
});

describe("gone with their worktree: one computation, used by both views", () => {
  const orphans = [gone("acme/orbit-api:old", 0.8 * GB), gone("acme/orbit-web:old", 0.3 * GB)];

  test("orphanUniqueBytes just sums each orphan's own (already-unique) bytes", () => {
    expect(orphanUniqueBytes(orphans)).toBe(1.1 * GB);
    expect(orphanUniqueBytes([gone("a:old", null)])).toBe(0);
  });

  test("the Disk card's orphanBytes and the Images banner's gone-bytes agree, fed the same orphans", () => {
    const diskBytes = dm(disk({ orphans }), []).orphanBytes;
    const images = [img("acme/orbit-api:old", "0.8GB"), img("acme/orbit-web:old", "0.3GB")];
    const bannerRest = imagesView(images, [], orphans).rest;
    expect(diskBytes).toBe(1.1 * GB);
    expect(bannerRest).toContain("1.1 GB of it gone with their worktree");
  });
});

describe("the budget", () => {
  test("defaults to the app's own, so a call without one cannot invent a number", () => {
    expect(diskMath(disk({ buildCache: BUILD_CACHE_BUDGET }), []).cacheOver).toBe(0);
    expect(diskMath(disk({ buildCache: BUILD_CACHE_BUDGET + GB }), []).cacheOver).toBe(GB);
  });
});

describe("reclaimableBy: the legend and the total are one set of numbers", () => {
  test("cache and containers promise only what a button frees; docker's figure is a secondary line", () => {
    const m = dm(disk({ images: 10 * GB, buildCache: 5 * GB, containers: 2 * GB, volumes: 3 * GB,
      reclaimableBy: { images: 4 * GB, containers: GB, volumes: 3 * GB, buildCache: 2 * GB } }), []);
    const go = Object.fromEntries(m.legend.map((l) => [l.key, l.canGo]));
    expect(go).toEqual({ images: 4 * GB, cache: m.cacheOver, volumes: 0, containers: 0 });
    expect(m.back).toBe(m.legend.reduce((n, l) => n + l.canGo, 0));
    expect(m.back).toBe(4 * GB + m.cacheOver);
    const says = Object.fromEntries(m.legend.map((l) => [l.key, l.dockerSays]));
    expect(says.cache).toBe(2 * GB);
    expect(says.containers).toBe(GB);
  });
});
