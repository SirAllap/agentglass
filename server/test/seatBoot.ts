/*
 * Starts the server with a seat credential already minted.
 *
 * `auth.ts` keeps seat tokens in memory, so a test process cannot mint one for
 * another process: the token has to be made where the routes are served.
 * `SEAT_BOOT_TOKEN` is the file it is written to and `SEAT_BOOT_ROOT` the
 * project the seat speaks for.
 */
import { writeFileSync } from "node:fs";
import { mintSeatToken } from "../src/auth.ts";

const out = process.env.SEAT_BOOT_TOKEN;
const root = process.env.SEAT_BOOT_ROOT;
if (out && root) writeFileSync(out, mintSeatToken(root, "speak"));
await import("../src/index.ts");
