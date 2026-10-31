/**
 * The agent rules, as stored: one list per project plus the base set, every
 * rule with where it came from, and every change to it.
 *
 * The base set is also what a launch carries (`launch.mode`, `launch.deny`):
 * config.json keeps a mirror of the base mode and the base `never` rules, so
 * launchperm.ts and the Settings page read what they always read, and an old
 * build reading the same config sees the same list. A write through either
 * door lands in both.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { launchDeny, launchMode, writeLaunchPermissions } from "./config.ts";
import { projectRootOf } from "./git.ts";
import { DEFAULT_LAUNCH_DENY, isLaunchMode, parseDenyRules, type LaunchMode } from "../../shared/launchModes.ts";
import {
  BASE_PROJECT, BASE_RULES, MODE_ACTION, RULES_MAX_PER_PROJECT, decide, inForceFor, isLooser, isLooserMode, ruleFor, shellSegments, primaryInput, wouldPrompt,
  type AgentRule, type AgentRulesView, type RuleChange, type RuleCheck, type RuleSetting, type RuleSource, type RuleWrite,
} from "../../shared/agentRules.ts";
import type { Applied, DoorAnswer } from "./settingsDoor.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS agent_rules (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  action TEXT NOT NULL,
  match TEXT NOT NULL,
  setting TEXT NOT NULL,
  source TEXT NOT NULL,
  by_name TEXT NOT NULL,
  at INTEGER NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  mode TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_rules_key ON agent_rules (project, action, match);
CREATE TABLE IF NOT EXISTS agent_rule_changes (
  rule_id TEXT NOT NULL,
  project TEXT NOT NULL,
  from_setting TEXT,
  to_setting TEXT NOT NULL,
  by_name TEXT NOT NULL,
  at INTEGER NOT NULL,
  applied INTEGER NOT NULL,
  waits INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_rule_changes_project ON agent_rule_changes (project, at);
`);

interface Row { id: string; project: string; action: string; match: string; setting: string; source: string; by_name: string; at: number; pending: number; dismissed: number; mode: string | null }

const toRule = (r: Row): AgentRule => ({
  id: r.id, project: r.project, action: r.action, match: r.match, setting: r.setting as RuleSetting,
  source: r.source as RuleSource, by: r.by_name, at: r.at,
  ...(r.pending ? { pending: true } : {}), ...(r.mode && isLaunchMode(r.mode) ? { mode: r.mode } : {}),
});

const newId = () => `ar_${randomBytes(9).toString("hex")}`;
let now = () => Date.now();
/** Tests move the clock to fill `weekly`. */
export function __setRulesClock(fn: () => number) { now = fn; }

/** The approval card. index.ts hands the settings door in once it exists; no door, no card, the row still waits. */
let door: { askExternal: (r: Parameters<import("./settingsDoor.ts").Door["askExternal"]>[0]) => DoorAnswer; drop(key: string): void } | null = null;
export function setRulesDoor(d: typeof door) { door = d; }

const rootCache = new Map<string, string>();
/**
 * The project a path belongs to: the main repo root, so every worktree of a
 * repo shares one list. A path outside any repo is its own project.
 * shortcut: cached per path for the server's life; a directory that becomes a
 * repo later keeps its first answer until a restart.
 */
export function ruleRoot(path: string): string {
  if (path === BASE_PROJECT) return path;
  const hit = rootCache.get(path);
  if (hit) return hit;
  const r = projectRootOf(path) ?? path.replace(/\/+$/, "");
  if (rootCache.size > 500) rootCache.clear();
  rootCache.set(path, r);
  return r;
}

function note(ruleId: string, project: string, from: RuleSetting | null, to: RuleSetting, by: string, applied: boolean, waits: boolean) {
  db.query("INSERT INTO agent_rule_changes VALUES (?,?,?,?,?,?,?,?)").run(ruleId, project, from, to, by, now(), applied ? 1 : 0, waits ? 1 : 0);
}

const all = (): Row[] => db.query("SELECT * FROM agent_rules WHERE dismissed = 0").all() as Row[];
const one = (id: string) => db.query("SELECT * FROM agent_rules WHERE id = ?").get(id) as Row | null;
const byKey = (project: string, action: string, match: string) =>
  db.query("SELECT * FROM agent_rules WHERE project = ? AND action = ? AND match = ?").get(project, action, match) as Row | null;
const byMatch = (project: string, match: string) =>
  db.query("SELECT * FROM agent_rules WHERE project = ? AND match = ? AND dismissed = 0 AND action != ?").get(project, match, MODE_ACTION) as Row | null;
/** The row a write lands on, a dismissed suggestion included: the pattern is still that row's in the unique key. */
const rowFor = (project: string, match: string) =>
  db.query("SELECT * FROM agent_rules WHERE project = ? AND match = ? AND action != ? ORDER BY dismissed").get(project, match, MODE_ACTION) as Row | null;
/** Rules in force in a project: what the cap counts. Suggestions have a cap of their own. */
const liveCount = (project: string) =>
  (db.query("SELECT COUNT(*) AS n FROM agent_rules WHERE project = ? AND pending = 0 AND dismissed = 0").get(project) as { n: number }).n;

/**
 * The base set, made once from what config.json holds today: the mode, and
 * the deny list as `never` rules. A base rule the person had taken off the deny
 * list arrives as `allow`, so nothing a launch did yesterday changes today.
 */
let seeded = false;

/**
 * Every pending first-seen suggestion stored before the shell split respected
 * quotes and heredocs: that split made `ERROR`, `- master` and `EOF` out of
 * quoted text, and no row it made can be told apart from a real one. A real
 * one comes back the next time it is seen. Runs once per database.
 */
function dropOldSplitSuggestions() {
  dropOnce("shell-split-v2");
  // The row does not say which mode the call ran in, so every pending one goes: a real one comes back the next time the session asks.
  dropOnce("only-asked-v1");
}

function dropOnce(name: string) {
  db.exec("CREATE TABLE IF NOT EXISTS agent_rules_once (name TEXT PRIMARY KEY)");
  if (db.query("INSERT OR IGNORE INTO agent_rules_once (name) VALUES (?)").run(name).changes === 0) return;
  db.query("DELETE FROM agent_rules WHERE pending = 1 AND source = 'first-seen'").run();
}

export function ensureBase() {
  if (seeded) return;
  seeded = true;
  dropOldSplitSuggestions();
  if (db.query("SELECT 1 FROM agent_rules WHERE project = ? LIMIT 1").get(BASE_PROJECT)) return;
  const deny = launchDeny();
  const insert = (action: string, match: string, setting: RuleSetting, source: RuleSource, mode: LaunchMode | null) => {
    const id = newId();
    db.query("INSERT INTO agent_rules (id, project, action, match, setting, source, by_name, at, mode) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, BASE_PROJECT, action, match, setting, source, source === "base" ? "agentglass" : "you", now(), mode);
  };
  const tx = db.transaction(() => {
    const m = launchMode();
    insert(MODE_ACTION, "", m === "default" ? "ask" : "allow", m === "default" ? "base" : "you", m);
    for (const b of BASE_RULES) {
      const inDeny = deny.includes(b.match);
      const setting: RuleSetting = inDeny ? "never" : b.setting === "never" ? "allow" : b.setting;
      const shipped = (DEFAULT_LAUNCH_DENY.includes(b.match) && inDeny) || (!DEFAULT_LAUNCH_DENY.includes(b.match) && setting === b.setting);
      insert(b.action, b.match, setting, shipped ? "base" : "you", null);
    }
    for (const d of deny) if (!BASE_RULES.some((b) => b.match === d)) insert(actionOf(d), d, "never", "you", null);
  });
  tx();
}

/** A readable key for a pattern nobody named: `Bash(npm publish:*)` → `bash.npm.publish`. */
export function actionOf(match: string): string {
  const m = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/.exec(match);
  if (!m) return "custom";
  const words = (m[2] ?? "").replace(/:\*$/, "").split(/\s+/).filter((w) => /^[A-Za-z0-9_.-]+$/.test(w)).slice(0, 3);
  return [m[1]!.toLowerCase(), ...words].join(".").slice(0, 80);
}

/** The base mode and `never` rules into config.json, where a launch reads them. */
function mirror(): Applied {
  const base = all().filter((r) => r.project === BASE_PROJECT && !r.pending);
  const mode = base.find((r) => r.action === MODE_ACTION)?.mode;
  const deny = base.filter((r) => r.action !== MODE_ACTION && r.setting === "never").map((r) => r.match);
  const w = writeLaunchPermissions({ ...(mode && isLaunchMode(mode) ? { mode } : {}), deny });
  return w.ok ? { ok: true } : { ok: false, error: w.error ?? "could not save the launch permissions" };
}

/** Every rule that applies to one project, base included, pending left out. */
export function liveRules(): AgentRule[] {
  ensureBase();
  return all().map(toRule);
}

export function check(rootIn: string, tool: string, input: unknown, mode?: string): RuleCheck {
  const root = ruleRoot(rootIn);
  const rules = liveRules();
  const verdict = decide(rules, root, tool, input);
  if (verdict.decision === "unknown" && wouldPrompt(mode, tool)) firstSeen(rules, root, tool, input);
  return verdict;
}

/**
 * One quiet suggestion per action a project has no rule for. Never more than
 * one, never back once dismissed. Waiting suggestions keep to their own cap,
 * oldest out first, so they never crowd out a rule the person writes.
 */
function firstSeen(rules: AgentRule[], root: string, tool: string, input: unknown) {
  const calls = tool === "Bash" ? shellSegments(primaryInput(input)).map((s) => ({ command: s })) : [input];
  for (const c of calls) {
    if (decide(rules, root, tool, c).decision !== "unknown") continue;
    const s = ruleFor(tool, c);
    if (!s) continue;
    if (byKey(root, s.action, s.match)) continue;
    db.query(`DELETE FROM agent_rules WHERE id IN (SELECT id FROM agent_rules WHERE project = ? AND pending = 1 AND dismissed = 0 AND source = 'first-seen'
      ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(root, RULES_MAX_PER_PROJECT - 1);
    const id = newId();
    db.query("INSERT OR IGNORE INTO agent_rules (id, project, action, match, setting, source, by_name, at, pending) VALUES (?,?,?,?,?,?,?,?,1)")
      .run(id, root, s.action, s.match, "allow", "first-seen", "agentglass", now());
  }
}

const WEEK = 7 * 86_400_000;

export function view(rootIn: string): AgentRulesView {
  const root = ruleRoot(rootIn);
  const rows = liveRules();
  const base = rows.filter((r) => r.project === BASE_PROJECT && !r.pending);
  const learned = rows.filter((r) => r.project === root && !r.pending);
  const suggested = rows.filter((r) => (r.project === root || r.project === BASE_PROJECT) && r.pending);
  const history = (db.query("SELECT * FROM agent_rule_changes WHERE project IN (?, ?) ORDER BY at DESC LIMIT 50").all(root, BASE_PROJECT) as {
    rule_id: string; from_setting: string | null; to_setting: string; by_name: string; at: number; applied: number; waits: number;
  }[]).map((c): RuleChange => ({
    ruleId: c.rule_id, from: c.from_setting as RuleSetting | null, to: c.to_setting as RuleSetting, by: c.by_name, at: c.at, applied: !!c.applied, waitsForPerson: !!c.waits,
  }));
  const t = now();
  const weekly = Array.from({ length: 8 }, (_, i) => {
    const end = t - (7 - i) * WEEK;
    return learned.filter((r) => r.at > end - WEEK && r.at <= end).length;
  });
  const mode = base.find((r) => r.action === MODE_ACTION)?.mode ?? launchMode();
  return { root, mode, base, learned, suggested, history, weekly };
}

export type RulesAnswer = { ok: true; write: RuleWrite } | { ok: false; error: string; status: number };

/**
 * One rule written by somebody. The person's applies at once. An agent's
 * applies at once when it is stricter than what is in force; a looser one is
 * stored pending and put on the approval card, and nothing changes until the
 * person answers it.
 */
export async function setRule(
  b: { root?: unknown; action?: unknown; match?: unknown; setting?: unknown; source?: unknown; mode?: unknown },
  who: { person: boolean; by: string },
): Promise<RulesAnswer> {
  ensureBase();
  if (typeof b.root !== "string" || !(b.root === BASE_PROJECT || b.root.startsWith("/"))) return { ok: false, error: 'root: a project\'s absolute path, or "*" for every project', status: 400 };
  const root = ruleRoot(b.root);
  const source: RuleSource = b.source === "chat" || b.source === "always-allow" ? b.source : who.person ? "you" : "chat";
  const by = who.person ? "you" : who.by;

  if (b.action === MODE_ACTION) {
    if (root !== BASE_PROJECT) return { ok: false, error: 'the permission mode is one for every project: root "*"', status: 400 };
    if (!isLaunchMode(b.mode)) return { ok: false, error: "mode: default, auto, acceptEdits or bypassPermissions", status: 400 };
    const cur = byKey(BASE_PROJECT, MODE_ACTION, "")!;
    const from = (cur.mode && isLaunchMode(cur.mode) ? cur.mode : "default") as LaunchMode;
    const setting: RuleSetting = b.mode === "default" ? "ask" : "allow";
    const write = (): Applied => {
      db.query("UPDATE agent_rules SET mode = ?, setting = ?, source = ?, by_name = ?, at = ?, pending = 0 WHERE id = ?").run(b.mode as string, setting, source, by, now(), cur.id);
      note(cur.id, BASE_PROJECT, cur.setting as RuleSetting, setting, by, true, false);
      return mirror();
    };
    if (who.person || !isLooserMode(from, b.mode)) {
      const a = write();
      return a.ok ? { ok: true, write: { rule: toRule(one(cur.id)!), applied: true, waitsForPerson: false } } : { ok: false, error: a.error, status: 500 };
    }
    note(cur.id, BASE_PROJECT, cur.setting as RuleSetting, setting, by, false, true);
    const card = door?.askExternal({ setting: "agent.rules", label: "Agent rules", key: `${cur.id}:mode:${b.mode}`, who: by, diff: [`permission mode: ${from} -> ${b.mode}`, "every project"], apply: write });
    if (card && !card.ok) return { ok: false, error: card.error, status: card.status };
    return { ok: true, write: { rule: { ...toRule(cur), mode: b.mode, pending: true }, applied: false, waitsForPerson: true } };
  }

  if (typeof b.match !== "string") return { ok: false, error: "match: a tool pattern, e.g. Bash(git push:*)", status: 400 };
  const parsed = parseDenyRules(b.match.trim());
  if (parsed.bad.length || parsed.rules.length !== 1) return { ok: false, error: `match: not a tool pattern: ${b.match.slice(0, 60)}`, status: 400 };
  const match = parsed.rules[0]!;
  if (b.setting !== "allow" && b.setting !== "ask" && b.setting !== "never") return { ok: false, error: "setting: allow, ask or never", status: 400 };
  const setting = b.setting;
  const prior = rowFor(root, match);
  const action = typeof b.action === "string" && /^[a-z][a-z0-9._-]{0,79}$/.test(b.action) ? b.action : prior?.action ?? actionOf(match);
  // What is in force for the calls this pattern names, whichever rule speaks for them:
  // `Bash(gh pr merge 1:*)` = ask under a never on `gh pr merge` hands an agent more.
  const from = inForceFor(liveRules(), root, match);
  const looser = !who.person && isLooser(from, setting);
  // Only an agent's looser write is ever refused for room; the person's and a stricter one always land.
  if (looser && !(prior && !prior.dismissed) && liveCount(root) >= RULES_MAX_PER_PROJECT) {
    return { ok: false, error: `this project already has ${RULES_MAX_PER_PROJECT} rules`, status: 409 };
  }

  const id = prior?.id ?? newId();
  if (!prior) {
    db.query("INSERT INTO agent_rules (id, project, action, match, setting, source, by_name, at, pending) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, root, action, match, setting, source, by, now(), looser ? 1 : 0);
  } else if (!looser) {
    db.query("UPDATE agent_rules SET action = ?, setting = ?, source = ?, by_name = ?, at = ?, pending = 0, dismissed = 0 WHERE id = ?").run(action, setting, source, by, now(), id);
  } else if (prior.pending) {
    // A pending suggestion an agent now asks for: it stays pending, with the agent's words on it.
    db.query("UPDATE agent_rules SET setting = ?, source = ?, by_name = ?, at = ?, dismissed = 0 WHERE id = ?").run(setting, source, by, now(), id);
  }
  if (!looser) {
    note(id, root, from, setting, by, true, false);
    door?.drop(id);
    if (root === BASE_PROJECT) {
      const a = mirror();
      if (!a.ok) return { ok: false, error: a.error, status: 500 };
    }
    return { ok: true, write: { rule: toRule(one(id)!), applied: true, waitsForPerson: false } };
  }
  note(id, root, from, setting, by, false, true);
  // A looser change to a rule already in force waits as its own request; the rule stays as it is.
  const apply = (): Applied => {
    const cur = one(id);
    if (!cur) return { ok: false, error: "the rule is gone" };
    db.query("UPDATE agent_rules SET setting = ?, source = ?, by_name = ?, at = ?, pending = 0, dismissed = 0 WHERE id = ?").run(setting, source, by, now(), id);
    note(id, root, from, setting, "you", true, false);
    return root === BASE_PROJECT ? mirror() : { ok: true };
  };
  const card = door?.askExternal({
    setting: "agent.rules", label: "Agent rules", key: id, root: root === BASE_PROJECT ? undefined : root, who: by,
    diff: [`${match}: ${from ?? "no rule"} -> ${setting}`, root === BASE_PROJECT ? "every project" : `project ${root}`], apply,
  });
  if (card && !card.ok) return { ok: false, error: card.error, status: card.status };
  const shown = toRule(one(id)!);
  return { ok: true, write: { rule: { ...shown, setting, pending: true }, applied: false, waitsForPerson: true } };
}

/**
 * The person's answer to a suggestion or a waiting ask: a setting makes it a
 * rule in force; `dismiss` drops a suggestion for good (it is not suggested again).
 */
export function answer(id: string, b: { setting?: unknown; dismiss?: unknown }, person: boolean): RulesAnswer {
  if (!person) return { ok: false, error: "only the person answers a rule: an agent cannot approve one, its own included", status: 403 };
  const cur = one(id);
  if (!cur) return { ok: false, error: "no such rule", status: 404 };
  door?.drop(id);
  if (b.dismiss === true) {
    if (!cur.pending) return { ok: false, error: "only a suggestion is dismissed; set a rule in force to what it should be instead", status: 400 };
    db.query("UPDATE agent_rules SET dismissed = 1 WHERE id = ?").run(id);
    // Dismissals are remembered up to the cap, newest kept; an older one dropped may be suggested again.
    db.query(`DELETE FROM agent_rules WHERE id IN (SELECT id FROM agent_rules WHERE project = ? AND dismissed = 1
      ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(cur.project, RULES_MAX_PER_PROJECT);
    return { ok: true, write: { rule: toRule(cur), applied: false, waitsForPerson: false } };
  }
  if (b.setting !== "allow" && b.setting !== "ask" && b.setting !== "never") return { ok: false, error: "setting: allow, ask or never (or dismiss: true)", status: 400 };
  if (cur.action === MODE_ACTION) return { ok: false, error: "the mode is set with action launch.mode", status: 400 };
  db.query("UPDATE agent_rules SET setting = ?, source = CASE WHEN pending = 1 THEN source ELSE 'you' END, by_name = 'you', at = ?, pending = 0 WHERE id = ?")
    .run(b.setting, now(), id);
  note(id, cur.project, cur.pending ? null : (cur.setting as RuleSetting), b.setting, "you", true, false);
  if (cur.project === BASE_PROJECT) {
    const a = mirror();
    if (!a.ok) return { ok: false, error: a.error, status: 500 };
  }
  return { ok: true, write: { rule: toRule(one(id)!), applied: true, waitsForPerson: false } };
}

/**
 * A write through the old doors (Settings ▸ launch permissions, POST
 * /launch-permissions): config.json first, as before, then the base set follows
 * it. A pattern taken off the deny list becomes `allow` when it is one of the
 * shipped base rules and goes away when somebody had added it.
 */
export function writeLaunchBase(fields: { mode?: unknown; deny?: unknown }, by = "you"): { ok: boolean; persisted: boolean; error?: string } {
  ensureBase();
  const w = writeLaunchPermissions(fields);
  if (!w.ok) return w;
  const tx = db.transaction(() => {
    const mode = launchMode();
    const m = byKey(BASE_PROJECT, MODE_ACTION, "");
    if (m && m.mode !== mode) {
      const setting: RuleSetting = mode === "default" ? "ask" : "allow";
      db.query("UPDATE agent_rules SET mode = ?, setting = ?, source = 'you', by_name = ?, at = ? WHERE id = ?").run(mode, setting, by, now(), m.id);
      note(m.id, BASE_PROJECT, m.setting as RuleSetting, setting, by, true, false);
    }
    const deny = launchDeny();
    const base = all().filter((r) => r.project === BASE_PROJECT && r.action !== MODE_ACTION && !r.pending);
    for (const r of base) {
      if (r.setting !== "never" || deny.includes(r.match)) continue;
      if (BASE_RULES.some((x) => x.match === r.match)) {
        db.query("UPDATE agent_rules SET setting = 'allow', source = 'you', by_name = ?, at = ? WHERE id = ?").run(by, now(), r.id);
        note(r.id, BASE_PROJECT, "never", "allow", by, true, false);
      } else {
        db.query("DELETE FROM agent_rules WHERE id = ?").run(r.id);
      }
    }
    for (const d of deny) {
      const r = byMatch(BASE_PROJECT, d);
      if (r?.setting === "never" && !r.pending) continue;
      if (r) db.query("UPDATE agent_rules SET setting = 'never', source = 'you', by_name = ?, at = ?, pending = 0 WHERE id = ?").run(by, now(), r.id);
      else db.query("INSERT INTO agent_rules (id, project, action, match, setting, source, by_name, at) VALUES (?,?,?,?,?,?,?,?)").run(newId(), BASE_PROJECT, actionOf(d), d, "never", "you", by, now());
      const id = (r ?? byMatch(BASE_PROJECT, d))!.id;
      note(id, BASE_PROJECT, (r?.setting as RuleSetting) ?? null, "never", by, true, false);
    }
  });
  tx();
  return w;
}

/** Tests: forget the in-memory state between files that share one database. */
export function __resetRulesStore() {
  seeded = false;
  rootCache.clear();
  db.exec("DELETE FROM agent_rules; DELETE FROM agent_rule_changes;");
}
