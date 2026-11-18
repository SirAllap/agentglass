// Btrfs snapshots are listed but cannot be sized without root: the line says so
// and carries the exact command for the person to run. Nothing here runs sudo.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDiskCtx, scanDisk, snapshotSizeCommand, type Runner } from "../src/diskclean.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-snap-test-"));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

test("an unsized snapshots line carries the command to size it, and no sudo is run", async () => {
  const snaps = join(dir, "orbit-snapshots");
  mkdirSync(snaps);
  const calls: string[] = [];
  const run: Runner = async (cmd) => { calls.push(cmd); return { code: 127, stdout: "", stderr: "", missing: true }; };
  const r = await scanDisk(defaultDiskCtx({ home: dir, run, procDir: join(dir, "no-proc"), swaps: () => "", snapshotsDir: snaps, repos: [] }));
  const line = r.lines.find((l) => l.id === "snapshots")!;
  expect(line.bytes).toBeNull();
  expect(line.sizeCommand).toBe(`sudo btrfs filesystem du -s --human-readable '${snaps}'`);
  expect(line.sizeCommand).toBe(snapshotSizeCommand(snaps));
  expect(calls).not.toContain("sudo");
});
