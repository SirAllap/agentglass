/*
 * The agent rules as stored: who may write what, when a change waits for the
 * person, what is suggested and what is never suggested again, and that the
 * base set stays the mirror of what a launch carries in config.json.
 *
 * In-process, on the scratch database `bun test` gives every file; the config
 * the base set is seeded from lives in a private XDG_CONFIG_HOME.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-rules-store-")));
const saved = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");

const store = await import("../src/agentRulesStore.ts");
const { db } = await import("../src/db.ts");
const cfg = await import("../src/config.ts");
const { DEFAULT_LAUNCH_DENY } = await import("../../shared/launchModes.ts");

const ROOT = join(dir, "acme", "orbit");
mkdirSync(ROOT, { recursive: true });
Bun.spawnSync(["git", "init", "-q", ROOT]);

/** A call in a session that would have stopped to ask: what a suggestion needs. */
const asked = (root: string, tool: string, input: unknown) => store.check(root, tool, input, "default");

type Ask = Parameters<NonNullable<Parameters<typeof store.setRulesDoor>[0]>["askExternal"]>[0];
let cards: Ask[] = [];
let dropped: string[] = [];
store.setRulesDoor({
  askExternal: (r) => { cards.push(r); return { ok: true, applied: false, pending: { id: "sr_x", setting: r.setting, label: r.label, who: r.who, diff: r.diff, at: 0, expires: 1 } }; },
  drop: (k) => { dropped.push(k); },
});

const person = { person: true, by: "you" };
const agent = { person: false, by: "an agent calling itself \"builder-1\"" };
const push = { root: ROOT, match: "Bash(git push:*)" };
const bash = (command: string) => ({ command });

beforeEach(() => {
  cards = []; dropped = [];
  cfg.writeLaunchPermissions({ mode: "default", deny: DEFAULT_LAUNCH_DENY.join("\n") });
  store.__resetRulesStore();
  store.__setRulesClock(() => Date.now());
});
afterAll(() => {
  store.__resetRulesStore();
  store.__setRulesClock(() => Date.now());
  store.setRulesDoor(null);
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.cfg], ["XDG_DATA_HOME", saved.data], ["AGENTGLASS_STATE_DIR", saved.state]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("who may write what", () => {
  test("an agent going stricter applies at once, with no card", async () => {
    expect(store.check(ROOT, "Bash", bash("git push origin main")).decision).toBe("allow");
    const r = await store.setRule({ ...push, setting: "never" }, agent);
    expect(r.ok && r.write).toMatchObject({ applied: true, waitsForPerson: false });
    expect(cards).toHaveLength(0);
    expect(store.check(ROOT, "Bash", bash("git push origin main")).decision).toBe("never");
  });

  test("an agent going looser waits: the rule stays, a card is asked, approving applies it", async () => {
    await store.setRule({ ...push, setting: "never" }, person);
    const r = await store.setRule({ ...push, setting: "allow" }, agent);
    expect(r.ok && r.write).toMatchObject({ applied: false, waitsForPerson: true });
    expect(store.check(ROOT, "Bash", bash("git push")).decision).toBe("never");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ setting: "agent.rules", root: ROOT, who: agent.by });
    expect(cards[0]!.diff[0]).toContain("never -> allow");
    expect(store.view(ROOT).history[0]).toMatchObject({ from: "never", to: "allow", applied: false, waitsForPerson: true });

    expect(await cards[0]!.apply()).toEqual({ ok: true });
    expect(store.check(ROOT, "Bash", bash("git push")).decision).toBe("allow");
  });

  test("an agent loosening a base never waits, and the base is untouched until the card is approved", async () => {
    const merge = { root: "*", match: "Bash(gh pr merge:*)", setting: "allow" };
    const r = await store.setRule(merge, agent);
    expect(r.ok && r.write.waitsForPerson).toBe(true);
    expect(cfg.launchDeny()).toContain("Bash(gh pr merge:*)");
    expect(cards[0]!.root).toBeUndefined();
    await cards[0]!.apply();
    expect(cfg.launchDeny()).not.toContain("Bash(gh pr merge:*)");
  });

  test("a rule the project never had, asked looser than `ask`, waits too", async () => {
    const r = await store.setRule({ root: ROOT, match: "Bash(npm publish:*)", setting: "allow" }, agent);
    expect(r.ok && r.write.waitsForPerson).toBe(true);
    expect(store.check(ROOT, "Bash", bash("npm publish")).decision).toBe("unknown");
  });

  test("the person's write applies at once, looser included", async () => {
    await store.setRule({ ...push, setting: "never" }, person);
    const r = await store.setRule({ ...push, setting: "allow" }, person);
    expect(r.ok && r.write).toMatchObject({ applied: true, waitsForPerson: false });
    expect(cards).toHaveLength(0);
    expect(store.check(ROOT, "Bash", bash("git push")).decision).toBe("allow");
  });

  test("answer() refuses anybody but the person, and changes nothing", async () => {
    asked(ROOT, "Bash", bash("npm publish"));
    const id = store.view(ROOT).suggested[0]!.id;
    const r = store.answer(id, { setting: "allow" }, false);
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(store.view(ROOT).suggested).toHaveLength(1);
    expect(store.answer(id, { setting: "allow" }, true)).toMatchObject({ ok: true });
    expect(store.check(ROOT, "Bash", bash("npm publish")).decision).toBe("allow");
  });

  test("a source of always-allow from the person writes an allow rule", async () => {
    const r = await store.setRule({ root: ROOT, match: "Bash(npm test:*)", setting: "allow", source: "always-allow" }, person);
    expect(r.ok && r.write.rule).toMatchObject({ setting: "allow", source: "always-allow", by: "you" });
    expect(store.check(ROOT, "Bash", bash("npm test --watch")).decision).toBe("allow");
  });

  test("a mode looser than the one in force waits for the person; the person's applies", async () => {
    const r = await store.setRule({ root: "*", action: "launch.mode", mode: "bypassPermissions", match: "" }, agent);
    expect(r.ok && r.write.waitsForPerson).toBe(true);
    expect(cfg.launchMode()).toBe("default");
    await cards[0]!.apply();
    expect(cfg.launchMode()).toBe("bypassPermissions");
    expect((await store.setRule({ root: "*", action: "launch.mode", mode: "default", match: "" }, agent)).ok).toBe(true);
    expect(cfg.launchMode()).toBe("default");
  });
});

describe("first seen", () => {
  test("repeated identical checks leave exactly one suggestion, and it decides nothing", () => {
    for (let i = 0; i < 4; i++) expect(asked(ROOT, "Bash", bash("npm publish --tag beta")).decision).toBe("unknown");
    const v = store.view(ROOT);
    expect(v.suggested).toHaveLength(1);
    expect(v.suggested[0]).toMatchObject({ match: "Bash(npm publish:*)", source: "first-seen", pending: true });
    expect(v.learned).toHaveLength(0);
  });

  test("a call that only reads, or that a rule covers, suggests nothing", () => {
    asked(ROOT, "Read", { file_path: "/x" });
    asked(ROOT, "Bash", bash("ls -la"));
    asked(ROOT, "Bash", bash("git push"));
    expect(store.view(ROOT).suggested).toHaveLength(0);
  });

  test("a dismissed suggestion never comes back", () => {
    asked(ROOT, "Bash", bash("npm publish"));
    const id = store.view(ROOT).suggested[0]!.id;
    expect(store.answer(id, { dismiss: true }, true)).toMatchObject({ ok: true });
    asked(ROOT, "Bash", bash("npm publish"));
    asked(ROOT, "Bash", bash("npm publish --tag x"));
    expect(store.view(ROOT).suggested).toHaveLength(0);
  });

  test("a loop makes suggestions for its commands, never for its keywords", () => {
    asked(ROOT, "Bash", bash("for n in 1 2; do npm publish $n; done"));
    expect(store.view(ROOT).suggested.map((r) => r.match)).toEqual(["Bash(npm publish:*)"]);
  });

  test("a never on gh pr merge still holds inside a loop, an if and $(...)", async () => {
    await store.setRule({ root: ROOT, match: "Bash(gh pr merge:*)", setting: "never" }, person);
    for (const c of ["for n in 1 2; do gh pr merge $n; done", "if true; then gh pr merge 1; fi", "echo $(gh pr merge 1)", "X=1 gh pr merge 2 && ls"]) {
      expect(store.check(ROOT, "Bash", bash(c)).decision).toBe("never");
    }
  });

  test("pending first-seen rows from before the new split are dropped once; anything else stays", () => {
    store.liveRules();
    store.__resetRulesStore();
    const ins = (action: string, match: string, pending = 1, source = "first-seen") =>
      db.query("INSERT INTO agent_rules (id, project, action, match, setting, source, by_name, at, pending) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(`r_${action}`, ROOT, action, match, "allow", source, "agentglass", 1, pending);
    ins("bash.-.master", "Bash(- master:*)");
    ins("bash.ERROR", "Bash(ERROR:*)");
    ins("bash.npm.publish", "Bash(npm publish:*)");
    ins("bash.make", "Bash(make:*)", 0);
    ins("bash.git.push", "Bash(git push:*)", 1, "chat");
    db.query("DELETE FROM agent_rules_once").run();
    expect(store.view(ROOT).suggested.map((r) => r.match)).toEqual(["Bash(git push:*)"]);
    // the marker holds: a suggestion stored after the migration survives the next start
    store.__resetRulesStore();
    ins("bash.npm.publish", "Bash(npm publish:*)");
    expect(store.view(ROOT).suggested.map((r) => r.match)).toEqual(["Bash(npm publish:*)"]);
  });

  test("a call that ran without asking files nothing, in any mode that never asks", () => {
    for (const mode of ["bypassPermissions", "auto", "dontAsk", undefined]) {
      expect(store.check(ROOT, "Bash", bash("make build"), mode).decision).toBe("unknown");
      store.check(ROOT, "Write", { file_path: "/x" }, mode);
    }
    expect(store.view(ROOT).suggested).toHaveLength(0);
  });

  test("default and plan file a suggestion; acceptEdits files it for a command, not for an edit", () => {
    store.check(ROOT, "Bash", bash("make build"), "default");
    store.check(ROOT, "Bash", bash("npm publish"), "acceptEdits");
    store.check(ROOT, "Edit", { file_path: "/x" }, "acceptEdits");
    store.check(ROOT, "Write", { file_path: "/x" }, "plan");
    expect(store.view(ROOT).suggested.map((r) => r.match).sort()).toEqual(["Bash(make build:*)", "Bash(npm publish:*)", "Write"]);
  });

  test("gh and git global flags before the subcommand do not change the rule", () => {
    for (const c of ["gh --repo acme/orbit pr checks 12", "gh -R acme/orbit pr view 3", "git -C ../wt log -3", "git -c core.pager=cat --no-pager diff"]) asked(ROOT, "Bash", bash(c));
    expect(store.view(ROOT).suggested.map((r) => r.match).sort()).toEqual(["Bash(gh pr:*)", "Bash(git diff:*)", "Bash(git log:*)"]);
  });

  test("a never on git push holds with -C in front of it", async () => {
    await store.setRule({ root: ROOT, match: "Bash(git push:*)", setting: "never" }, person);
    expect(store.check(ROOT, "Bash", bash("git -C ../wt push --force")).decision).toBe("never");
  });

  test("text in quotes and heredocs suggests nothing; the commands around it do", () => {
    const lines = [
      `grep -E "ERROR|Error|FAILED|Traceback|408" log | npm publish`,
      `git commit -m "$(cat <<'EOF'\nFix packfile | not ready; to master\n\n- master\n- code\n- pre & ready\n- in\nI could; summary fails\nEOF\n)"`,
      `gh pr edit 5 --body "update description | Dockerfile; Dockerfile.nginx && Ran 1"`,
      "X=1 make build # last | EOF",
    ];
    for (const c of lines) asked(ROOT, "Bash", bash(c));
    expect(store.view(ROOT).suggested.map((r) => r.match).sort()).toEqual(["Bash(gh pr:*)", "Bash(git commit:*)", "Bash(make build:*)", "Bash(npm publish:*)"]);
  });

  test("pending first-seen rows from calls that may have run freely are dropped once", () => {
    store.liveRules();
    store.__resetRulesStore();
    const ins = (action: string, match: string, source = "first-seen") =>
      db.query("INSERT INTO agent_rules (id, project, action, match, setting, source, by_name, at, pending) VALUES (?,?,?,?,?,?,?,?,1)")
        .run(`r_${action}`, ROOT, action, match, "allow", source, "agentglass", 1);
    ins("bash.git.add", "Bash(git add:*)");
    ins("bash.git.push", "Bash(git push:*)", "chat");
    db.query("DELETE FROM agent_rules_once WHERE name = 'only-asked-v1'").run();
    expect(store.view(ROOT).suggested.map((r) => r.match)).toEqual(["Bash(git push:*)"]);
    store.__resetRulesStore();
    ins("bash.git.add", "Bash(git add:*)");
    expect(store.view(ROOT).suggested.map((r) => r.match)).toEqual(["Bash(git add:*)"]);
  });

  test("a worktree shares the list of its repo", () => {
    const wt = join(dir, "acme", "orbit-wt");
    Bun.spawnSync(["git", "-C", ROOT, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
    Bun.spawnSync(["git", "-C", ROOT, "worktree", "add", "-q", wt, "-b", "side"]);
    asked(wt, "Bash", bash("npm publish"));
    expect(store.view(ROOT).suggested).toHaveLength(1);
  });
});

describe("precedence and room", () => {
  test("Allow on a broad suggestion does not allow what a base never covers", async () => {
    asked(ROOT, "Bash", bash("gh pr view 3"));
    const s = store.view(ROOT).suggested.find((r) => r.match === "Bash(gh pr:*)")!;
    expect(store.answer(s.id, { setting: "allow" }, true)).toMatchObject({ ok: true });
    expect(store.check(ROOT, "Bash", bash("gh pr view 3")).decision).toBe("allow");
    expect(store.check(ROOT, "Bash", bash("gh pr merge 12")).decision).toBe("never");
  });

  test("an agent cannot weaken a never through another key without the person", async () => {
    // broader: applies, but the never still speaks for merges
    const broad = await store.setRule({ root: ROOT, match: "Bash(gh pr:*)", setting: "ask" }, agent);
    expect(broad.ok && broad.write.applied).toBe(true);
    expect(store.check(ROOT, "Bash", bash("gh pr merge 12")).decision).toBe("never");
    // narrower: it would speak for those merges, so it waits
    const narrow = await store.setRule({ root: ROOT, match: "Bash(gh pr merge 12:*)", setting: "ask" }, agent);
    expect(narrow.ok && narrow.write).toMatchObject({ applied: false, waitsForPerson: true });
    expect(cards[0]!.diff[0]).toContain("never -> ask");
    expect(store.check(ROOT, "Bash", bash("gh pr merge 12")).decision).toBe("never");
  });

  test("a dismissed suggestion's pattern can still be written, by the person and by an agent going stricter", async () => {
    asked(ROOT, "Bash", bash("gh pr view 3"));
    const id = store.view(ROOT).suggested[0]!.id;
    store.answer(id, { dismiss: true }, true);
    const r = await store.setRule({ root: ROOT, match: "Bash(gh pr:*)", setting: "never" }, person);
    expect(r.ok && r.write).toMatchObject({ applied: true });
    expect(store.check(ROOT, "Bash", bash("gh pr view 3")).decision).toBe("never");
    expect(store.view(ROOT).learned.map((x) => x.match)).toContain("Bash(gh pr:*)");

    asked(ROOT, "Bash", bash("npm publish"));
    store.answer(store.view(ROOT).suggested[0]!.id, { dismiss: true }, true);
    const a = await store.setRule({ root: ROOT, match: "Bash(npm publish:*)", setting: "never" }, agent);
    expect(a.ok && a.write.applied).toBe(true);
  });

  test("suggestions never crowd out the person's rules, and keep to their own cap", async () => {
    const { RULES_MAX_PER_PROJECT } = await import("../../shared/agentRules.ts");
    for (let i = 0; i < RULES_MAX_PER_PROJECT + 5; i++) asked(ROOT, "Bash", bash(`tool${i} run`));
    expect(store.view(ROOT).suggested).toHaveLength(RULES_MAX_PER_PROJECT);
    // the oldest went first
    expect(store.view(ROOT).suggested.some((r) => r.match === "Bash(tool0 run:*)")).toBe(false);
    for (const r of store.view(ROOT).suggested) store.answer(r.id, { dismiss: true }, true);
    const w = await store.setRule({ root: ROOT, match: "Bash(npm publish:*)", setting: "never" }, person);
    expect(w.ok).toBe(true);
    expect(store.check(ROOT, "Bash", bash("npm publish")).decision).toBe("never");
  });

  test("dismissals keep the newest per project, up to the cap", async () => {
    const { RULES_MAX_PER_PROJECT } = await import("../../shared/agentRules.ts");
    let t = 1_000;
    store.__setRulesClock(() => t++);
    const dismissAll = () => { for (const r of [...store.view(ROOT).suggested].sort((x, y) => x.at - y.at)) store.answer(r.id, { dismiss: true }, true); };
    for (let i = 0; i < RULES_MAX_PER_PROJECT; i++) asked(ROOT, "Bash", bash(`tool${i} run`));
    dismissAll();
    for (let i = RULES_MAX_PER_PROJECT; i < RULES_MAX_PER_PROJECT + 3; i++) asked(ROOT, "Bash", bash(`tool${i} run`));
    dismissAll();
    const left = db.query("SELECT match FROM agent_rules WHERE project = ? AND dismissed = 1").all(ROOT) as { match: string }[];
    expect(left).toHaveLength(RULES_MAX_PER_PROJECT);
    expect(left.some((r) => r.match === "Bash(tool2 run:*)")).toBe(false);
    expect(left.some((r) => r.match === "Bash(tool3 run:*)")).toBe(true);
    expect(left.some((r) => r.match === `Bash(tool${RULES_MAX_PER_PROJECT + 2} run:*)`)).toBe(true);
  });

  test("a suggestion the person answered is credited to the person, and still says where it came from", () => {
    asked(ROOT, "Bash", bash("npm publish"));
    const id = store.view(ROOT).suggested[0]!.id;
    const r = store.answer(id, { setting: "ask" }, true);
    expect(r.ok && r.write.rule).toMatchObject({ source: "first-seen", by: "you", setting: "ask" });
  });
});

describe("the base set and the launch it mirrors", () => {
  test("a fresh install seeds the shipped base", () => {
    const base = store.view(ROOT).base;
    const by = (m: string) => base.find((r) => r.match === m);
    expect(by("Bash(git push:*)")).toMatchObject({ setting: "allow", source: "base" });
    expect(by("Bash(gh pr merge:*)")).toMatchObject({ setting: "never", source: "base" });
    expect(by("Bash(gh release:*)")).toMatchObject({ setting: "never", source: "base" });
  });

  test("migration: a deny list the person edited keeps meaning what it meant", () => {
    cfg.writeLaunchPermissions({ deny: ["Bash(gh release:*)", "Bash(npm publish:*)"].join("\n") });
    store.__resetRulesStore();
    const before = cfg.launchDeny();
    const base = store.view(ROOT).base;
    const by = (m: string) => base.find((r) => r.match === m);
    expect(by("Bash(gh pr merge:*)")).toMatchObject({ setting: "allow", source: "you" });
    expect(by("Bash(npm publish:*)")).toMatchObject({ setting: "never", source: "you" });
    expect(by("Bash(gh release:*)")).toMatchObject({ setting: "never" });
    expect(store.check(ROOT, "Bash", bash("gh pr merge 3")).decision).toBe("allow");
    expect(store.check(ROOT, "Bash", bash("npm publish")).decision).toBe("never");
    // the launch reads what it always read
    expect(cfg.launchDeny()).toEqual(before);
    expect(cfg.launchMode()).toBe("default");
  });

  test("seeding does not rewrite the launch of a fresh install", () => {
    const before = [cfg.launchDeny(), cfg.launchMode()];
    store.view(ROOT);
    expect([cfg.launchDeny(), cfg.launchMode()]).toEqual(before);
  });

  test("a write through the old door lands in the rules, and the other way round", async () => {
    store.view(ROOT);
    store.writeLaunchBase({ deny: "Bash(gh release:*)\nBash(npm publish:*)" });
    expect(store.check(ROOT, "Bash", bash("gh pr merge 1")).decision).toBe("allow");
    expect(store.check(ROOT, "Bash", bash("npm publish")).decision).toBe("never");
    await store.setRule({ root: "*", match: "Bash(npm publish:*)", setting: "allow" }, person);
    expect(cfg.launchDeny()).toEqual(["Bash(gh release:*)"]);
  });
});

describe("weekly", () => {
  test("counts what the project learned per week, this week last", async () => {
    const T = Date.UTC(2026, 9, 26);
    const WEEK = 7 * 86_400_000;
    store.__setRulesClock(() => T - 2 * WEEK);
    await store.setRule({ root: ROOT, match: "Bash(npm test:*)", setting: "allow" }, person);
    store.__setRulesClock(() => T - 1000);
    await store.setRule({ root: ROOT, match: "Bash(npm run:*)", setting: "allow" }, person);
    await store.setRule({ root: ROOT, match: "Bash(make:*)", setting: "ask" }, person);
    store.__setRulesClock(() => T);
    const w = store.view(ROOT).weekly;
    expect(w).toHaveLength(8);
    expect(w[7]).toBe(2);
    expect(w[5]).toBe(1);
    expect(w.reduce((a, b) => a + b, 0)).toBe(3);
  });
});
