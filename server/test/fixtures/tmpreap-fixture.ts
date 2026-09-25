/*
 * Not a suite — the subject of one. `tmpreap.test.ts` runs this in a child
 * `bun test`, waits until it has made its scratch space, and SIGKILLs it, which
 * is the one exit the sweep in tmpsweep.ts cannot see.
 *
 * Named without `.test.` so the normal run never collects it.
 */
import { test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "agx-reapfix-"));
writeFileSync(process.env.TMPREAP_REPORT!, scratch);

test("waits to be killed", async () => { await Bun.sleep(60_000); }, 70_000);
