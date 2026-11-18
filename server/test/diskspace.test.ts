import { beforeEach, describe, expect, test } from "bun:test";
import { checkDiskSpace, criticalCrossing, criticalText, diskSpaceState, onDiskCritical, resetDiskSpace } from "../src/diskclean.ts";

const GB = 1e9;

describe("diskSpaceState edges", () => {
  test("critical is under 5 GB, whatever the size", () => {
    expect(diskSpaceState(4.99 * GB, 100 * GB)).toBe("critical");
    expect(diskSpaceState(0, 0)).toBe("critical");
  });
  test("exactly 5 GB is low, not critical", () => {
    expect(diskSpaceState(5 * GB, 1000 * GB)).toBe("low");
  });
  test("under 15 GB is low even on a huge disk", () => {
    expect(diskSpaceState(14.9 * GB, 100 * GB)).toBe("low");
    expect(diskSpaceState(15 * GB, 100 * GB)).toBe("ok");
  });
  test("under 10% is low even above 15 GB", () => {
    expect(diskSpaceState(30 * GB, 400 * GB)).toBe("low");
    expect(diskSpaceState(40 * GB, 400 * GB)).toBe("ok");
  });
});

describe("once per crossing", () => {
  test("fires on the first critical, then stays quiet", () => {
    const a = criticalCrossing(true, "critical");
    expect(a).toEqual({ fire: true, armed: false });
    expect(criticalCrossing(a.armed, "critical").fire).toBe(false);
  });
  test("low does not re-arm; ok does", () => {
    expect(criticalCrossing(false, "low")).toEqual({ fire: false, armed: false });
    expect(criticalCrossing(false, "ok")).toEqual({ fire: false, armed: true });
  });
  test("low alone never notifies", () => {
    expect(criticalCrossing(true, "low").fire).toBe(false);
  });
});

describe("checkDiskSpace", () => {
  beforeEach(() => resetDiskSpace());
  const at = (freeGb: number) => async () => ({ bsize: 1, blocks: 500 * GB, bavail: freeGb * GB });
  test("one notification across a crossing and its repeat, again after recovery", async () => {
    const said: string[] = [];
    onDiskCritical((t) => said.push(t));
    await checkDiskSpace("/h", at(4.2));
    await checkDiskSpace("/h", at(4.0));
    await checkDiskSpace("/h", at(12));
    expect(said).toEqual(["Disk almost full: 4.2 GB free. Open Disk cleanup to free space."]);
    await checkDiskSpace("/h", at(100));
    await checkDiskSpace("/h", at(3));
    expect(said.length).toBe(2);
    onDiskCritical(null);
  });
  test("text", () => expect(criticalText(4.2 * GB)).toBe("Disk almost full: 4.2 GB free. Open Disk cleanup to free space."));
});
