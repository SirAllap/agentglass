// A credential minted for a tab the layout route started was written to disk
// as a hash and could never be restored: after a restart only a named agent
// is asked whether it is alive, and such a tab is a tmux window, not one. Its
// first use was refused and the row deleted. It is no longer written.
import { afterAll, expect, test } from "bun:test";
import { db } from "../src/db.ts";
import { mintWorkerToken, restorableWorkerName, revokeWorkerTokens, UNRESTORABLE_WORKER_PREFIXES, workerTokenLive } from "../src/auth.ts";
import { layoutCredentialName } from "../src/browseraccess.ts";

const LAYOUT = layoutCredentialName("orbit", "@3", "4242.1700000000");
const NAMED = "orbit-restorable-builder";
const rows = (name: string) => (db.query("SELECT COUNT(*) AS n FROM worker_credential WHERE name = ?").get(name) as { n: number }).n;

afterAll(() => { revokeWorkerTokens(LAYOUT); revokeWorkerTokens(NAMED); });

test("the layout route's name is one of the names that are not kept", () => {
  expect(restorableWorkerName(LAYOUT)).toBe(false);
  expect(restorableWorkerName("seat-cred:orbit")).toBe(false);
  expect(restorableWorkerName(NAMED)).toBe(true);
  // The prefix here and the one the route builds its names with cannot drift apart.
  expect(UNRESTORABLE_WORKER_PREFIXES.some((p) => LAYOUT.startsWith(p))).toBe(true);
});

test("a layout tab's credential works in this life and leaves no row; a named worker's is kept", () => {
  const tab = mintWorkerToken(LAYOUT, 60_000, true, "/tmp/acme-orbit");
  expect(workerTokenLive(tab)).toBe(true);
  expect(rows(LAYOUT)).toBe(0);
  mintWorkerToken(NAMED, 60_000, true, "/tmp/acme-orbit");
  expect(rows(NAMED)).toBe(1);
});

const source = await Bun.file(new URL("../src/auth.ts", import.meta.url)).text();

test("rows an earlier build wrote for such names are dropped when the module loads", () => {
  expect(source).toContain("db.run(`DELETE FROM worker_credential WHERE name LIKE 'layout:%'`);");
});
