/*
 * Starts the server with worker credentials already minted.
 *
 * `auth.ts` keeps worker tokens in memory, so a test process cannot mint one
 * for another process: the token has to be made where the routes are served.
 * This file is that process. It lives in the repository on purpose — a
 * sandboxed plugin's bridge resolves the tree it binds read-only from
 * `Bun.main` (`bridgeExtraRo` in `plugins.ts`), and a launcher under `/tmp`
 * makes that tree `/`, which bwrap then cannot mount a socket into.
 *
 * `WORKER_BOOT_NAMES` is a comma-separated list of worker names and
 * `WORKER_BOOT_TOKENS` the file they are written to, keyed `a`, `b`, ….
 */
import { writeFileSync } from "node:fs";
import { mintWorkerToken } from "../src/auth.ts";

const out = process.env.WORKER_BOOT_TOKENS;
const names = (process.env.WORKER_BOOT_NAMES ?? "").split(",").filter(Boolean);
if (out && names.length > 0) {
  const tokens = Object.fromEntries(names.map((n, i) => [String.fromCharCode(97 + i), mintWorkerToken(n)]));
  writeFileSync(out, JSON.stringify(tokens));
}
await import("../src/index.ts");
