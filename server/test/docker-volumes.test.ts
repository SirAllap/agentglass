/*
 * Volumes with a size, a holder and a look inside.
 *
 * The parsing is what is pinned here, because it is what silently rots: docker
 * prints human sizes in decimal units whatever anybody thinks of that, and
 * `ls -l` comes from busybox on one machine and coreutils on the next. A
 * misread size is a number somebody will act on — it is the whole basis of
 * "which of these 32 volumes can I delete".
 */
import { describe, expect, test } from "bun:test";
import { humanSize, parseSize, parseStat, parseTotals, pickPeekImage } from "../src/dockervolumes.ts";

describe("docker's own sizes", () => {
  test("the shapes it prints", () => {
    expect(parseSize("1.9GB")).toBe(1_900_000_000);
    expect(parseSize("318MB")).toBe(318_000_000);
    expect(parseSize("1.317GB")).toBe(1_317_000_000);
    expect(parseSize("0B")).toBe(0);
    expect(parseSize("512kB")).toBe(512_000);
  });

  /* Decimal, not binary. Being consistent with `docker system df` matters more
     than being right about SI: the two numbers sit next to each other. */
  test("GiB is read as docker means it", () => {
    expect(parseSize("2GiB")).toBe(2_000_000_000);
  });

  test("nothing readable is null, never zero", () => {
    // Zero is a real size and "I could not read it" is not; conflating them
    // makes an unknown volume look empty, which is how you delete one.
    expect(parseSize("")).toBe(null);
    expect(parseSize(null)).toBe(null);
    expect(parseSize("N/A")).toBe(null);
  });
});

describe("how a size reads", () => {
  test("scanned, not audited", () => {
    expect(humanSize(1_900_000_000)).toBe("1.9 GB");
    expect(humanSize(318_000_000)).toBe("318 MB");
    expect(humanSize(950)).toBe("950 B");
    expect(humanSize(0)).toBe("0 B");
  });

  test("unknown says so instead of showing a zero", () => {
    expect(humanSize(null)).toBe("—");
    expect(humanSize(undefined)).toBe("—");
  });
});

describe("reading a listing", () => {
  /* `stat -c '%F|%s|%Y|%n'`, which is what the peek actually runs. It is NOT
     `ls -l`, and that is the whole point: this was written against coreutils
     and measured against alpine, whose busybox `ls` has no `--time-style` at
     all — so the version that parsed on the machine it was written on would
     have failed on almost every real one. */
  const out = [
    "directory|4096|1755594720|/v/keypad",
    "directory|4096|1755364800|/v/vr-dash",
    "regular file|98304|1755594600|/v/reverse.js",
    "symbolic link|7|1754042400|/v/latest",
  ].join("\n");

  test("directories, files, sizes and times", () => {
    const e = parseStat(out);
    expect(e.filter((x) => x.dir).map((x) => x.name)).toEqual(["keypad", "vr-dash"]);
    expect(e.find((x) => x.name === "reverse.js")).toMatchObject({ dir: false, bytes: 98304 });
  });

  test("the time is ISO to the minute, in UTC", () => {
    // A local-time string from inside a container is a different clock wearing
    // the same shirt as the one on the host.
    expect(parseStat("regular file|1|1755594600|/v/x")[0]!.when).toBe("2025-08-19 09:10");
  });

  test("directories first, then files, each alphabetical", () => {
    expect(parseStat(out).map((x) => x.name)).toEqual(["keypad", "vr-dash", "latest", "reverse.js"]);
  });

  test("a name is the leaf, not the whole path", () => {
    expect(parseStat("regular file|10|1755594600|/v/dist/app/index.js")[0]!.name).toBe("index.js");
  });

  test("and a name containing a pipe survives", () => {
    // The separator is in the format, so everything past the third field is the
    // path — splitting naively would truncate a legitimate filename.
    expect(parseStat("regular file|10|1755594600|/v/we|rd.txt")[0]!.name).toBe("we|rd.txt");
  });

  test("a directory has no size of its own to report", () => {
    // 4096 is the directory entry, not what is inside it, and printing it as a
    // size is a number that means nothing.
    expect(parseStat("directory|4096|1755594600|/v/keypad")[0]!.bytes).toBe(null);
  });

  test("noise is skipped rather than becoming a row", () => {
    expect(parseStat("find: /v/nope: No such file or directory\n")).toEqual([]);
    expect(parseStat("")).toEqual([]);
  });
});

describe("what an image would actually give back", () => {
  /* Measured on a real machine: 25 images tagged for worktrees that are gone
     add up to 149GB of `Size` and free 40.6GB when deleted, because they share
     a base layer. The panel promises the second number. */
  test("UniqueSize is carried alongside Size", () => {
    const df = JSON.stringify({
      Images: [{ ID: "sha256:abc123abc123def", Repository: "orbit-django", Tag: "orbit-web-1042", Size: "6.19GB", UniqueSize: "1.056GB", Containers: "0" }],
      Volumes: [], Containers: [], BuildCache: [],
    });
    // parseSize is what reads both; the shape is asserted where diskUsage
    // builds it, and this pins that the two are not confused for each other.
    expect(parseSize(JSON.parse(df).Images[0].Size)).toBe(6_190_000_000);
    expect(parseSize(JSON.parse(df).Images[0].UniqueSize)).toBe(1_056_000_000);
  });
});

describe("the totals line", () => {
  /* Taken from `docker system df` and NOT from `-v`, measured on a real
     daemon: the verbose output has no Reclaimable field at all, and its
     per-image Size counts shared layers once per image — summing it gave three
     hundred gigabytes on a machine docker itself calls 91.89GB. */
  const df = [
    '{"Active":"6","Reclaimable":"45.67GB (49%)","Size":"91.89GB","TotalCount":"55","Type":"Images"}',
    '{"Active":"13","Reclaimable":"0B (0%)","Size":"31.78MB","TotalCount":"13","Type":"Containers"}',
    '{"Active":"9","Reclaimable":"6.2GB (77%)","Size":"7.996GB","TotalCount":"31","Type":"Local Volumes"}',
    '{"Active":"0","Reclaimable":"174.1GB","Size":"177GB","TotalCount":"645","Type":"Build Cache"}',
  ].join("\n");

  test("one number per type, in docker's own arithmetic", () => {
    expect(parseTotals(df)).toEqual({
      images: 91_890_000_000,
      containers: 31_780_000,
      volumes: 7_996_000_000,
      buildCache: 177_000_000_000,
      reclaimable: 45_670_000_000 + 6_200_000_000 + 174_100_000_000,
    });
  });

  test("the percentage docker appends is not a size", () => {
    expect(parseTotals('{"Reclaimable":"45.67GB (49%)","Size":"91.89GB","Type":"Images"}').reclaimable).toBe(45_670_000_000);
  });

  test("nothing readable is zero, not a crash", () => {
    expect(parseTotals("").images).toBe(0);
    expect(parseTotals("not json\n{broken").reclaimable).toBe(0);
  });
});

describe("which image a look inside may start", () => {
  /* The first version fell back to ANY local image when busybox and alpine
     were absent — a disclosure triangle starting whatever was on the machine,
     entrypoint and all. Only the two helpers are known to this code. */
  test("busybox first, alpine second, both under any tag and registry spelling", () => {
    expect(pickPeekImage(["postgres:16", "alpine:latest", "busybox:latest"])).toBe("busybox:latest");
    expect(pickPeekImage(["postgres:16", "alpine:latest"])).toBe("alpine:latest");
    expect(pickPeekImage(["alpine:3.20"])).toBe("alpine:3.20");
    expect(pickPeekImage(["alpine:3.20", "docker.io/library/busybox:1.36"])).toBe("docker.io/library/busybox:1.36");
  });
  test("with neither present nothing else is picked", () => {
    expect(pickPeekImage(["postgres:16", "acme/internal-tool:latest", "<none>:<none>", "alpine:<none>", "alpinist:latest", "my-alpine:1"])).toBeNull();
    expect(pickPeekImage([])).toBeNull();
  });
});
