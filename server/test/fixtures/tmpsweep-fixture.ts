/*
 * Not a suite — the subject of one. `tmpsweep.test.ts` runs this file in a
 * child `bun test` and then looks for the directories it leaves behind.
 *
 * Named without `.test.` so the normal run never collects it.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.env.TMPSWEEP_REPORT!;
const scratch = mkdtempSync(join(tmpdir(), "agx-sweepfix-"));
const fixed = join(tmpdir(), `agx-sweepfix-fixed-${process.pid}`);
mkdirSync(fixed, { recursive: true });
const socket = join(tmpdir(), `agx-sweepfix-sock-${process.pid}.sock`);
writeFileSync(socket, "");   // stands in for the socket tmux makes for a test
writeFileSync(out, [scratch, fixed, socket].join("\n"));

test("the fixture made its scratch space", () => {
  expect(scratch.startsWith(tmpdir())).toBe(true);
});
