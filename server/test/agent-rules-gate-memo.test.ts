/**
 * The gate asks the rules before every tool call of every session, and each
 * ask read every live rule from SQLite: a synchronous query per tool call on
 * the server's only thread. The rows are now kept until a rule is written.
 *
 * Two promises are pinned: asking costs no read while nothing changed, and a
 * rule written a moment ago is the rule the very next call meets.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-rules-memo-")));
const saved = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");

const store = await import("../src/agentRulesStore.ts");
const source = await Bun.file(new URL("../src/agentRulesStore.ts", import.meta.url)).text();

const ROOT = join(dir, "acme", "orbit");
mkdirSync(ROOT, { recursive: true });
Bun.spawnSync(["git", "init", "-q", ROOT]);

const person = { person: true, by: "you" };
const bash = (command: string) => ({ command });
/** A call in a session that never stops to ask, so the check itself files no suggestion. */
const gate = (command: string) => store.check(ROOT, "Bash", bash(command), "bypassPermissions").decision;

beforeEach(() => { store.__resetRulesStore(); });
afterAll(() => {
  store.__resetRulesStore();
  const put = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  put("XDG_CONFIG_HOME", saved.cfg); put("XDG_DATA_HOME", saved.data); put("AGENTGLASS_STATE_DIR", saved.state);
  rmSync(dir, { recursive: true, force: true });
});

test("fifty tool calls with no rule written read the rules once, not fifty times", () => {
  gate("git status"); // the first ask seeds the base set and reads it
  const before = store.rulesReads;
  for (let i = 0; i < 50; i++) gate(`ls /srv/orbit/${i}`);
  expect(store.rulesReads - before).toBe(0);
});

test("a rule written now is the rule the next call meets", async () => {
  expect(gate("git push origin feature")).not.toBe("never");
  const before = store.rulesReads;
  await store.setRule({ root: ROOT, match: "Bash(git push:*)", setting: "never" }, person);
  expect(gate("git push origin feature")).toBe("never");
  expect(store.rulesReads - before).toBeGreaterThan(0);
  const after = store.rulesReads;
  for (let i = 0; i < 20; i++) expect(gate("git push origin feature")).toBe("never");
  expect(store.rulesReads - after).toBe(0);
});

test("a suggestion the check itself files is on the list at once", () => {
  gate("git status");
  expect(store.view(ROOT).suggested.map((s) => s.match)).toEqual([]);
  store.check(ROOT, "Bash", bash("npm publish"), "default");
  expect(store.view(ROOT).suggested.map((s) => s.match)).toEqual(["Bash(npm publish:*)"]);
});

test("no statement in the store reaches the database except through the wrapper that moves the epoch", () => {
  const code = source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const direct = code.filter((l) => l.includes("realDb.")).map((l) => l.trim());
  expect(direct).toEqual([
    "query: (sql: string) => { if (WRITES.test(sql)) rulesEpoch++; return realDb.query(sql); },",
    "exec: (sql: string): void => { rulesEpoch++; realDb.exec(sql); },",
    "const tx = realDb.transaction(fn);",
    'const rows = realDb.query("SELECT * FROM agent_rules_all WHERE dismissed = 0").all() as Row[];',
  ]);
  // Every statement the wrapper lets through unmarked starts with a read.
  const made = [...source.matchAll(/\bdb\.query\(\s*[`"]\s*([A-Za-z]+)/g)].map((m) => m[1]!.toUpperCase());
  expect(made.length).toBeGreaterThan(20);
  for (const verb of made) expect(["SELECT", "INSERT", "UPDATE", "DELETE"]).toContain(verb);
});
