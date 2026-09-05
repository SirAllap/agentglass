/*
 * The words a volume row uses.
 *
 * Both of these print somebody's machine back at them, and both have a failure
 * mode that gets seen and not reported: a size that reads as empty when it is
 * really unknown, and a date that reads as "NaN days ago".
 */
import { describe, expect, test } from "bun:test";
import { humanSize, sinceLabel } from "../src/lib/dockerVolumeView.ts";

describe("sizes", () => {
  test("read at a glance", () => {
    expect(humanSize(1_900_000_000)).toBe("1.9 GB");
    expect(humanSize(318_000_000)).toBe("318 MB");
    expect(humanSize(0)).toBe("0 B");
  });

  /* Unknown and empty are different answers, and conflating them is how
     somebody deletes a volume that was simply never measured. */
  test("unknown is not zero", () => {
    expect(humanSize(null)).toBe("—");
    expect(humanSize(undefined)).toBe("—");
  });
});

describe("how long ago", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");

  test("coarse, because nobody decides anything on the minutes", () => {
    expect(sinceLabel("2026-08-19T11:58:00.000Z", now)).toBe("2m ago");
    expect(sinceLabel("2026-08-19T06:00:00.000Z", now)).toBe("6h ago");
    expect(sinceLabel("2026-08-16T12:00:00.000Z", now)).toBe("3d ago");
    expect(sinceLabel("2026-07-08T12:00:00.000Z", now)).toBe("6w ago");
  });

  test("a moment ago is 'just now', not '0m'", () => {
    expect(sinceLabel("2026-08-19T11:59:40.000Z", now)).toBe("just now");
  });

  /* A container's clock can be ahead of ours. "in -2 minutes" is the kind of
     thing people screenshot. */
  test("a timestamp in the future reads as just now", () => {
    expect(sinceLabel("2026-08-19T12:00:30.000Z", now)).toBe("just now");
  });

  test("nothing to say about nothing", () => {
    expect(sinceLabel(null, now)).toBe("");
    expect(sinceLabel("", now)).toBe("");
    expect(sinceLabel("not a date", now)).toBe("");
  });
});
