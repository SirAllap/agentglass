// Minting a worker credential ran three durable writes, each its own commit
// and fsync, on the server's only thread, at every worker start and every
// follow-up turn. It is one transaction now.
import { afterAll, expect, test } from "bun:test";
import { db } from "../src/db.ts";
import { mintWorkerToken, revokeWorkerTokens } from "../src/auth.ts";

const source = await Bun.file(new URL("../src/auth.ts", import.meta.url)).text();
const NAME = "orbit-onecommit-builder";
const rows = () => (db.query("SELECT COUNT(*) AS n FROM worker_credential WHERE name = ?").get(NAME) as { n: number }).n;

afterAll(() => revokeWorkerTokens(NAME));

test("a mint commits once", () => {
  const at = source.indexOf("export function mintWorkerToken(");
  expect(at).toBeGreaterThan(-1);
  const body = source.slice(at, source.indexOf("\n}\n", at));
  // Comments out first: the one above the transaction names the old calls.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  expect(code.split("durably(").length - 1).toBe(1);
  expect(code).toContain("durably(() => db.transaction(() => {");
});

test("replace and expiry still hold inside that one transaction", () => {
  const first = mintWorkerToken(NAME, 60_000, true, "/tmp/acme-orbit");
  expect(rows()).toBe(1);
  const second = mintWorkerToken(NAME, 60_000, true, "/tmp/acme-orbit");
  expect(second).not.toBe(first);
  expect(rows()).toBe(1);
  // replace: false leaves the live one and adds its own.
  mintWorkerToken(NAME, 60_000, false, "/tmp/acme-orbit");
  expect(rows()).toBe(2);
  // An expired row goes at the next mint of any name.
  db.run("UPDATE worker_credential SET expires_at = 1 WHERE name = ?", [NAME]);
  mintWorkerToken(NAME, 60_000, false, "/tmp/acme-orbit");
  expect(rows()).toBe(1);
});
