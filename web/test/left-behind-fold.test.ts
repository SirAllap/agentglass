/*
 * The Left behind list's fold: the same command in the same cwd state is one row
 * with a count, every pid stays behind that row, and the list shows at most
 * eight commands before it offers the rest.
 *
 * The fixture is the shape of a real report: one test run's thirty-one sleeps
 * from a scratchpad that is gone, a vite from a deleted checkout, a second vite
 * from one that is still there, and a bun that is hot.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEFT_ROWS, foldLeftBehind, leftTitle, shownLeft } from "../src/lib/leftBehind.ts";
import type { OrphanProc } from "../../shared/types.ts";

let pid = 4000;
const proc = (over: Partial<OrphanProc> = {}): OrphanProc => ({
  pid: pid++, comm: "sleep", cmd: "sleep 1", cwd: "/tmp/scratch", cwdGone: true, ageSec: 120, cpu: 0,
  rss: 1024, reasons: ["its parent is gone"], origin: null, session: null, hot: false, ...over,
});

describe("the same command in the same cwd state is one row", () => {
  it("thirty-one sleeps from a deleted folder fold into one row that counts them", () => {
    const input = Array.from({ length: 31 }, () => proc());
    const groups = foldLeftBehind(input);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(31);
    expect(leftTitle(groups[0]!)).toBe("sleep 1 x 31");
    expect(groups[0]!.procs).toEqual(input);
  });

  it("a group of one keeps the command alone, the way the row always read", () => {
    const [g] = foldLeftBehind([proc({ cmd: "bun test", comm: "bun" })]);
    expect(leftTitle(g!)).toBe("bun test");
  });

  it("the same command with a cwd that is still there is another row", () => {
    const groups = foldLeftBehind([proc(), proc({ cwdGone: false, cwd: "/tmp/live" }), proc({ cmd: "vite", comm: "node" })]);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1]);
    expect(groups.map((g) => g.cwdGone)).toEqual([true, false, true]);
  });

  it("keeps the server's order, so a hot group stays where it was", () => {
    const groups = foldLeftBehind([proc({ cmd: "vite", comm: "node", hot: true }), proc(), proc()]);
    expect(groups.map((g) => g.cmd)).toEqual(["vite", "sleep 1"]);
  });

  it("the row carries the oldest age, the group's CPU and every reason once", () => {
    const groups = foldLeftBehind([
      proc({ ageSec: 60, cpu: 1.5, reasons: ["its parent is gone"] }),
      proc({ ageSec: 600, cpu: 2.5, reasons: ["its parent is gone", "its folder is deleted"] }),
      proc({ ageSec: 300, cpu: 0.5 }),
    ]);
    const g = groups[0]!;
    expect(g.oldestSec).toBe(600);
    expect(g.cpu).toBe(4.5);
    expect(g.reasons).toEqual(["its parent is gone", "its folder is deleted"]);
  });

  it("one member with no CPU sample makes the total unknown, never a partial sum", () => {
    const groups = foldLeftBehind([
      proc({ cpu: 1.5 }),
      proc({ cpu: 2.5 }),
      proc({ cpu: null }),
    ]);
    expect(groups[0]!.cpu).toBeNull();
  });

  it("a group with no age and no second sample says so instead of inventing one", () => {
    const [g] = foldLeftBehind([proc({ ageSec: null, cpu: null }), proc({ ageSec: null, cpu: null })]);
    expect(g!.oldestSec).toBeNull();
    expect(g!.cpu).toBeNull();
  });
});

describe("at most eight rows, and Show all for the rest", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => proc({ cmd: `job-${i}` }));
  it("eight commands are shown and the rest are counted, not dropped", () => {
    const groups = foldLeftBehind(many(12));
    const { rows, hidden } = shownLeft(groups, false);
    expect(LEFT_ROWS).toBe(8);
    expect(rows).toHaveLength(8);
    expect(hidden).toBe(4);
  });
  it("Show all shows every command and hides none", () => {
    const { rows, hidden } = shownLeft(foldLeftBehind(many(12)), true);
    expect(rows).toHaveLength(12);
    expect(hidden).toBe(0);
  });
  it("a list that fits offers no toggle at all", () => {
    const { rows, hidden } = shownLeft(foldLeftBehind(many(3)), false);
    expect(rows).toHaveLength(3);
    expect(hidden).toBe(0);
  });
});

describe("a temp wrapper folds on the helper's own name", () => {
  const wrapper = (i: number): OrphanProc => {
    const dir = `/tmp/agx-volumes-${i.toString(36)}`;
    return proc({
      comm: "gio", cmd: `/bin/sh ${dir}/bin/gio mount -m`, cwd: `${dir} (deleted)`,
      origin: "a throwaway wrapper in a temp directory", ageSec: 2 * 86400 + 15 * 3600,
    });
  };
  const monitor = (): OrphanProc => proc({
    comm: "udisksctl", cmd: "/usr/bin/udisksctl monitor", cwd: "/home/dev/code/orbit-app", cwdGone: false,
    origin: "worktree orbit-app", ageSec: 73 * 60,
  });

  it("forty-three wrappers are one row named by the helper, not 43 rows", () => {
    const groups = foldLeftBehind(Array.from({ length: 43 }, (_, i) => wrapper(i)));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(43);
    expect(leftTitle(groups[0]!)).toBe("gio mount -m x 43");
  });

  it("the installed app's monitors stay on the first page beside them", () => {
    const input = [...Array.from({ length: 43 }, (_, i) => wrapper(i)), ...Array.from({ length: 4 }, monitor)];
    const { rows } = shownLeft(foldLeftBehind(input), false);
    expect(rows.some((g) => g.cmd.includes("udisksctl monitor"))).toBe(true);
  });
});

describe("the copy names the origin instead of an agent", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const config = readFileSync(join(ROOT, "docs/CONFIG.md"), "utf8");
  const api = readFileSync(join(ROOT, "web/src/lib/api.ts"), "utf8");
  it("the panel, the client and the cockpit page say left behind and where from", () => {
    // 43 of 47 helper rows on the measured machine came from a temp wrapper and
    // the rest include this app's own monitors, so no page may say only "agent".
    expect(api).toContain("a checkout, a scratchpad or a temp wrapper");
    expect(config).toContain("each with the origin it came from");
    expect(config).not.toContain("an agent's test run, or a named helper left");
    expect(config).toContain("so it is a hint, never proof");
  });
});

describe("the list is drawn from that fold", () => {
  const ROOT = join(import.meta.dir, "..", "src");
  const left = readFileSync(join(ROOT, "components/machine/LeftBehind.tsx"), "utf8");
  it("folds with the helper above, keeps the pids under a caret, and offers Show all", () => {
    expect(left).toContain("foldLeftBehind(rep?.procs ?? [])");
    expect(left).toContain("shownLeft(groups, showAll)");
    expect(left).toContain("aria-expanded={showAll}");
    expect(left).toContain('"Show fewer" : `Show all ${groups.length}`');
    expect(left).toContain("open.has(g.key) && g.procs.map");
  });
  it("a folded row still reaches every pid: Stop all goes one pid at a time through the single-stop route", () => {
    expect(left).toContain("for (const p of g.procs)");
    expect(left).toContain("api.machineOrphanStop(p.pid)");
  });
  it("a new report puts an armed group away, so the confirmation cannot name pids it did not show", () => {
    const load = left.slice(left.indexOf("const load = useCallback"), left.indexOf("useEffect(() => { load(true)"));
    expect(load).toContain("setRep(r)");
    expect(load).toContain("setArmedGroup(null)");
  });
  it("the caret takes its size from the icon ladder", () => {
    expect(left).toContain("<CaretIcon size={ICON.xs} />");
    expect(left).not.toContain("CaretIcon size={12}");
  });
});
