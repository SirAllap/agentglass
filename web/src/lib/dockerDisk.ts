/*
 * "How much can come back", from the same images the Images view lists.
 *
 * Every figure on the Disk view (the bar, the legend, the three reclaim cards
 * and the sentence under the total) comes out of `diskMath`, so they cannot
 * disagree. A total that promises 9 GB and frees 6 is worse than none.
 *
 * Volumes are not an input to anything that can go. There is no "prune
 * volumes": it frees a few gigabytes and takes every node_modules volume with
 * it, a cold install for every worktree at once.
 */
import type { DockerDisk, DockerImage } from "../../../shared/types.ts";
import { humanSize, parseSize } from "../../../shared/dockerSize.ts";

/** The build cache is kept under this. Same figure Disk.tsx prunes to today. */
export const BUILD_CACHE_BUDGET = 60_000_000_000;

/** An image's size in bytes; 0 when docker did not say, so a sum is never NaN. */
export const imageBytes = (i: Pick<DockerImage, "size">): number => parseSize(i.size) ?? 0;

export type SegmentKey = "images" | "orphans" | "dangling" | "cache" | "cache-over" | "volumes" | "containers";

export function diskMath(disk: DockerDisk, images: DockerImage[], budget = BUILD_CACHE_BUDGET) {
  const orphanIds = new Set(disk.orphans.map((o) => o.id));
  const dangling = images.filter((i) => i.dangling && !orphanIds.has(i.id));

  /* `docker images` counts a shared layer once per image, so the pieces can add
     up to more than the daemon's own images figure. Capping them at it keeps
     every segment inside its slice and the bar inside 100 %. */
  const orphanBytes = Math.min(disk.images, disk.orphans.reduce((n, o) => n + (o.bytes ?? 0), 0));
  const danglingBytes = Math.min(disk.images - orphanBytes, dangling.reduce((n, i) => n + imageBytes(i), 0));
  const cacheOver = Math.max(0, disk.buildCache - budget);
  const underBudget = cacheOver === 0;
  const back = cacheOver + orphanBytes + danglingBytes;
  const total = disk.images + disk.containers + disk.volumes + disk.buildCache;

  const segments: { key: SegmentKey; bytes: number; stripe: boolean }[] = ([
    ["images", disk.images - orphanBytes - danglingBytes, false],
    ["orphans", orphanBytes, true],
    ["dangling", danglingBytes, true],
    ["cache", disk.buildCache - cacheOver, false],
    ["cache-over", cacheOver, true],
    ["volumes", disk.volumes, false],
    ["containers", disk.containers, false],
  ] as const).map(([key, bytes, stripe]) => ({ key, bytes, stripe })).filter((s) => s.bytes > 0);

  const legend = [
    { key: "images", bytes: disk.images, canGo: orphanBytes + danglingBytes, note: "" },
    { key: "cache", bytes: disk.buildCache, canGo: cacheOver, note: underBudget ? "under the budget" : "" },
    { key: "volumes", bytes: disk.volumes, canGo: 0, note: "kept" },
    { key: "containers", bytes: disk.containers, canGo: 0, note: "" },
  ] as const;

  const plural = (n: number) => `${n} image${n === 1 ? "" : "s"}`;
  const cards = [
    { key: "cache" as const, count: null, frees: cacheOver, label: `Free ${humanSize(cacheOver)}`, none: underBudget },
    { key: "orph" as const, count: disk.orphans.length, frees: orphanBytes, label: `Remove ${plural(disk.orphans.length)}`, none: disk.orphans.length === 0 },
    { key: "dang" as const, count: dangling.length, frees: danglingBytes, label: `Remove ${plural(dangling.length)}`, none: dangling.length === 0 },
  ];

  return {
    total, back, segments, legend, cards, cacheOver, underBudget, orphanBytes, danglingBytes,
    orphanCount: disk.orphans.length,
    orphanTags: disk.orphans.map((o) => o.tag),
    danglingCount: dangling.length,
    /** What the "Remove dangling images" card removes: by id, since there is no tag. */
    danglingIds: dangling.map((i) => i.id),
    backText: back > 0 ? `${humanSize(back)} can come back` : "Nothing to give back right now",
  };
}
