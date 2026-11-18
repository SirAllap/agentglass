/*
 * A SEAT'S TOKEN USED TO DIE WITH THE PROCESS.
 *
 * `seatTokens` in auth.ts was in-memory only, so a server restart 401'd every
 * adopted orchestrator's own credential: the seat lost Go/resolve and the
 * person had to approve the adoption card again. Only the hash is on disk now
 * — see `seat_credential` in db.ts — and it is checked in constant time, the
 * same way a paired device's is.
 *
 * The restart is simulated the way gate-durability.test.ts does: a second
 * module registry for auth.ts, sharing the one database.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const ROOT = "/home/a/code/orbit";

const { mintSeatToken, revokeSeatTokens, callerFor } = await import("../src/auth.ts");
const { db, dbPath } = await import("../src/db.ts");

const withToken = (t: string) => ({
  req: new Request("http://x/", { headers: { Authorization: `Bearer ${t}` } }),
  url: new URL("http://x/"),
});

// Indirected through a variable: the query string is what forces a second
// module instance, and tsc can't resolve it as a literal specifier. A new
// query per call, not one fixed string: bun caches a module by its resolved
// specifier, so reusing "?restart=1" across tests would hand back the SAME
// fresh instance every time instead of a new one reading the db again.
let restarts = 0;
async function restartedAuth() {
  const path = `../src/auth.ts?restart=${++restarts}`;
  return (await import(path)) as typeof import("../src/auth.ts");
}

describe("a seat token outlives the process", () => {
  test("still answers after a restart, by the hash the db kept", async () => {
    const t = mintSeatToken(ROOT, "nudge");

    const fresh = await restartedAuth();
    const { req, url } = withToken(t);
    const caller = fresh.callerFor(req, url, "the-machine-token");
    expect(caller?.principal).toBe("seat");
    expect(caller?.seat?.root).toBe(ROOT);
    expect(caller?.seat?.powers).toBe("nudge");

    revokeSeatTokens(ROOT);
  });

  test("a released token is refused after the restart too", async () => {
    const t = mintSeatToken(ROOT, "assign");
    revokeSeatTokens(ROOT); // release before the "restart"

    const fresh = await restartedAuth();
    const { req, url } = withToken(t);
    expect(fresh.callerFor(req, url, "the-machine-token")).toBeNull();
  });

  test("the raw token is never written to the database file", () => {
    const t = mintSeatToken(ROOT, "speak");
    const raw = readFileSync(dbPath(), "latin1");
    expect(raw.includes(t)).toBe(false);
    revokeSeatTokens(ROOT);
  });
});

describe("re-adopting drops the old credential, same as release does", () => {
  test("the previous token is refused once a fresh one is minted for the same root", async () => {
    const first = mintSeatToken(ROOT, "speak");
    revokeSeatTokens(ROOT); // what re-adopt does before minting the replacement
    const second = mintSeatToken(ROOT, "assign");

    const fresh = await restartedAuth();
    const old = withToken(first);
    const now = withToken(second);
    expect(fresh.callerFor(old.req, old.url, "x")).toBeNull();
    expect(fresh.callerFor(now.req, now.url, "x")?.seat?.powers).toBe("assign");

    revokeSeatTokens(ROOT);
  });
});
