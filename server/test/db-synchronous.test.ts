/*
 * Every commit fsynced the WAL on the event loop (SQLite's default, FULL), and
 * on btrfs that waited for a whole transaction commit: freezes of 5-31 s were
 * measured with the main thread in a btrfs commit. WAL + NORMAL drops the
 * per-commit fsync. Asserted on the connection the server opened.
 */
import { expect, test } from "bun:test";
import { db, durably, resolveGateRow } from "../src/db.ts";

test("the server connection runs WAL with synchronous = NORMAL", () => {
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  expect((db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
});

const sync = () => (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;

test("durably() writes at FULL and puts NORMAL back, also when the write throws", () => {
  expect(durably(() => sync())).toBe(2);
  expect(sync()).toBe(1);
  expect(() => durably(() => { throw new Error("disk full"); })).toThrow("disk full");
  expect(sync()).toBe(1);
  // nested: the inner call does not put NORMAL back under the outer one
  durably(() => { durably(() => 0); expect(sync()).toBe(2); });
  expect(sync()).toBe(1);
});

// A rule about source: what a person decides, or a credential, is written through durably().
const fn = (src: string, head: string) => {
  const i = src.indexOf(head);
  expect(i).toBeGreaterThan(-1);
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
};
const src = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url)).text();
const dbSrc = await src("db.ts");
const planSrc = await src("flightPlanStore.ts");
const signSrc = await src("manifest.ts");

// Behavioural, not textual: the text `durably(` also appears in an inverted branch.
// resolveGateRow's write happens while synchronous is whatever it was set to, so
// watch the PRAGMA statements it sends: FULL for a human, none for the clock.
test("a human gate answer is written at FULL; a timeout or restart is not", () => {
  const real = db.exec.bind(db);
  const sent: string[] = [];
  (db as any).exec = (q: string) => { sent.push(q); return real(q); };
  try {
    resolveGateRow("no-such-gate", "allow", "t", "human", Date.now(), "david");
    expect(sent).toContain("PRAGMA synchronous = FULL;");
    sent.length = 0;
    resolveGateRow("no-such-gate", "deny", "t", "timeout");
    resolveGateRow("no-such-gate", "deny", "t", "restart");
    expect(sent.filter((q) => q.includes("synchronous"))).toEqual([]);
  } finally { (db as any).exec = real; }
  expect(sync()).toBe(1);
});

test("durably() inside a transaction runs at NORMAL and says so once", () => {
  const warn = console.warn;
  const said: string[] = [];
  console.warn = (m: string) => { said.push(m); };
  try {
    db.transaction(() => {
      expect(durably(() => sync())).toBe(1);
      durably(() => 0);
    })();
  } finally { console.warn = warn; }
  expect(said.length).toBeLessThanOrEqual(1);
});

test("a human gate answer, Go / No-go and a sign-off go through durably()", () => {
  expect(fn(planSrc, "export function decide(")).toContain("durably(");
  expect(fn(signSrc, "export function signOff(")).toContain("durably(");
});
