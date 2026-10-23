/*
 * What happens when an AGENT changes a setting: one line per setting.
 *
 * Every setting an agent can name, in the window (web/src/lib/settingsRegistry.ts)
 * or on the server (server/src/serverSettings.ts), has a class here, and a test
 * fails for a setting that has none (web/test/settingClass.test.ts,
 * server/test/settings-door.test.ts). A person's own change never reads this: it
 * applies, as it always did.
 *
 *   low         applies at once, stamped with the caller's name and audited.
 *   escalation  widens what agents may do, or which model and how much they
 *               spend. An agent's change waits as a request the person approves
 *               or declines with one click; approving applies exactly the diff the
 *               server computed and grants nothing for next time. Unanswered for
 *               REQUEST_TTL_MS, it is declined.
 *   personOnly  never through an agent, not even as a request: the switch that
 *               decides whether agents are asked at all, and what pairs or
 *               publishes the machine.
 *   secret      never read or written by an agent.
 *
 * `narrows(prev, next)` is true for a change that is safer or cheaper than what
 * it replaces (a gate on, a stricter mode, a longer interval, a list that only
 * loses members). Such a change from an agent applies at once even when the
 * class is escalation or personOnly: asking the person before making something
 * safer is the wrong way round. A row without `narrows` never narrows: every
 * change to it is a widening as far as this table can tell.
 */

export type SettingClass = "low" | "escalation" | "personOnly" | "secret";

export interface ClassRow {
  class: SettingClass;
  /** Why it is in that class, for `settings list`. */
  why: string;
  narrows?: (prev: unknown, next: unknown) => boolean;
}

/** How long an agent's request waits for the person before it counts as declined. */
export const REQUEST_TTL_MS = 30 * 60_000;

/** What the window answers for an escalation it will not apply without the person. */
export const NEEDS_APPROVAL = "needs the person's approval";

const LOW = (why = "a preference of the window: changes nothing an agent may do"): ClassRow => ({ class: "low", why });

/** Turning it off is the safer direction (`on` = widening). */
const offNarrows = (prev: unknown, next: unknown) => prev === true && next === false;
/** Turning it on is the safer direction (a gate). */
const onNarrows = (prev: unknown, next: unknown) => prev === false && next === true;
/** A bigger number is the cheaper direction (an interval between wakes). */
const higherNarrows = (prev: unknown, next: unknown) => typeof prev === "number" && typeof next === "number" && next > prev;
const items = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : [];
/** The new list only loses members. */
const subsetNarrows = (prev: unknown, next: unknown) => { const p = new Set(items(prev)); return items(next).every((x) => p.has(x)); };
/** The new list only gains members (a deny list). */
const supersetNarrows = (prev: unknown, next: unknown) => { const n = new Set(items(next)); return items(prev).every((x) => n.has(x)); };

/** Launch modes from strictest to loosest. */
const MODE_RANK: Record<string, number> = { default: 0, acceptEdits: 1, auto: 2, bypassPermissions: 3 };
const modeNarrows = (prev: unknown, next: unknown) =>
  typeof prev === "string" && typeof next === "string" && prev in MODE_RANK && next in MODE_RANK && MODE_RANK[next]! < MODE_RANK[prev]!;
const POWER_RANK: Record<string, number> = { speak: 0, nudge: 1, assign: 2 };
const powerNarrows = (prev: unknown, next: unknown) =>
  typeof prev === "string" && typeof next === "string" && prev in POWER_RANK && next in POWER_RANK && POWER_RANK[next]! < POWER_RANK[prev]!;

type BudgetLike = { root?: unknown; model?: unknown; period?: unknown; limit?: unknown };
const budgetKey = (b: BudgetLike) => `${String(b.root ?? "")}\u0000${String(b.model ?? "")}\u0000${String(b.period ?? "")}`;
/** Every budget that was there is still there, with a limit no higher; a new one only adds a ceiling. */
const budgetsNarrow = (prev: unknown, next: unknown) => {
  if (!Array.isArray(prev) || !Array.isArray(next)) return false;
  const now = new Map((next as BudgetLike[]).map((b) => [budgetKey(b), Number(b.limit)] as const));
  return (prev as BudgetLike[]).every((b) => { const l = now.get(budgetKey(b)); return l !== undefined && l <= Number(b.limit); });
};

const MORE_POWER = "widens what agents may do";
const COST = "decides which model runs and what it spends";

/**
 * One line per setting. A family (`rail.place.*`) covers every member a def
 * generates from a list; anything else is spelled out, so a new setting is a
 * decision and not an inheritance.
 */
export const SETTING_CLASSES: Readonly<Record<string, ClassRow>> = {
  // ── the window (web/src/lib/settingsRegistry.ts) ──
  "appearance.mode": LOW(), "appearance.theme": LOW(), "appearance.accent": LOW(),
  "diff.split": LOW(), "diff.wrap": LOW(), "diff.syntaxTheme": LOW(),
  "terminal.renderer": LOW(), "terminal.font": LOW(), "terminal.fontSize": LOW(), "terminal.lineHeight": LOW(),
  "terminal.cursor": LOW(), "terminal.focusFollowsMouse": LOW(), "terminal.paneBar": LOW(), "terminal.copyOnSelect": LOW(),
  "terminal.noteEditor": LOW(), "terminal.tabGroups": LOW(), "terminal.tabGroupRules": LOW(), "terminal.scrollback": LOW(),
  "terminal.wordSeparators": LOW(),
  "rail.place.*": LOW(), "tasks.source.*": LOW(), "keys.binding.*": LOW(),
  "notifications.quiet": LOW("only quiets what is not stopped: an agent blocked on the person still interrupts"),
  "notifications.ciOnlyApproved": LOW(), "notifications.talk": LOW(),
  "browser.searchEngine": LOW(), "tasks.landing": LOW(),
  "clickup.statusSpaces.counted": LOW(), "jira.statusUnits.counted": LOW(),
  "plugins.sessionReads.repos": { class: "escalation", why: "lets review plugins read the authoring session of more repositories", narrows: subsetNarrows },

  // ── the server (server/src/serverSettings.ts) ──
  "orchestration.policy": { class: "escalation", why: `which engine and model every worker and the chair run on, and when that changes: ${COST}` },
  "agents.role.*": { class: "escalation", why: `the engine and model a worker role starts with: ${COST}` },
  "launch.mode": { class: "escalation", why: `the permission mode every agent the app starts runs in: ${MORE_POWER}`, narrows: modeNarrows },
  "launch.deny": { class: "escalation", why: `what every agent the app starts may never do: ${MORE_POWER}`, narrows: supersetNarrows },
  "seat.model": { class: "escalation", why: `the chair's model: ${COST}` },
  "seat.kind": { class: "escalation", why: `the chair's engine: ${COST}` },
  "seat.powers": { class: "escalation", why: `what the chair may do to other agents: ${MORE_POWER}`, narrows: powerNarrows },
  "seat.change": { class: "escalation", why: `stands the chair down and seats it again on its stored engine: ${COST}` },
  "seat.wakeHours": { class: "escalation", why: "how often the chair is woken when nothing changes: a shorter floor spends more", narrows: higherNarrows },
  "hooks.gate": { class: "escalation", why: `the gate holds a tool call until a person decides: off ${MORE_POWER}`, narrows: onNarrows },
  "plugins.master": { class: "escalation", why: `the switch every plugin runs under: on ${MORE_POWER}`, narrows: offNarrows },
  "plugin.*.enabled": { class: "escalation", why: `runs a plugin with what its manifest declares: on ${MORE_POWER}`, narrows: offNarrows },
  "plugin.*.unboxed": { class: "escalation", why: `lets a plugin run outside its box: on ${MORE_POWER}`, narrows: offNarrows },
  "budgets": { class: "escalation", why: "the spending limits: raising or removing one lets agents spend more", narrows: budgetsNarrow },
  "lantern.nudge": { class: "escalation", why: "types prompts into idle agents, which spends tokens", narrows: offNarrows },
  "lantern.nudgeMinutes": { class: "escalation", why: "how soon an idle agent is nudged: shorter spends more", narrows: higherNarrows },
  "lantern.watch": { class: "escalation", why: "the orchestrator's wake, which spends tokens", narrows: offNarrows },
  "lantern.watchMinutes": { class: "escalation", why: "how often the orchestrator is woken: shorter spends more", narrows: higherNarrows },
  "lantern.cacheTtlMinutes": LOW("only how the cache countdown is drawn"),
  "jira.writes": { class: "escalation", why: "lets agentglass write to Jira cards with the person's account", narrows: offNarrows },
  "clickup.writes": { class: "escalation", why: "lets agentglass write to ClickUp with the person's account", narrows: offNarrows },
  "clickup.includeSubtasks": { class: "escalation", why: "a heavier read against a rate-limited token the person also works with", narrows: offNarrows },
  "agents.changeWithoutAsking": { class: "personOnly", why: "decides whether agents are asked at all: only the person turns it on, from Settings", narrows: offNarrows },
  "remote.serve": { class: "personOnly", why: "publishing this machine to the tailnet and pairing devices are the person's, on the Remote page" },
  "jira.token": { class: "secret", why: "a credential" },
  "clickup.token": { class: "secret", why: "a credential" },
  "github.token": { class: "secret", why: "a credential" },
};

/** The row for an id: its own, else the family it belongs to. A family's `*`
 *  stands for one dotted segment or more, never for nothing. */
export function classOf(id: string): ClassRow | null {
  if (Object.prototype.hasOwnProperty.call(SETTING_CLASSES, id)) return SETTING_CLASSES[id]!;
  for (const [k, row] of Object.entries(SETTING_CLASSES)) {
    if (!k.includes("*")) continue;
    const [head, tail] = k.split("*") as [string, string];
    if (id.length > head.length + tail.length && id.startsWith(head) && id.endsWith(tail)) return row;
  }
  return null;
}

/** What an agent's change does: applies at once, waits for the person, or is refused. */
export type Verdict = "apply" | "ask" | "refuse";

/**
 * The one decision, for a caller that is NOT the person. `trusted` is the
 * person's own switch (agents.changeWithoutAsking): it lets an escalation
 * through and never a personOnly or a secret, so the switch cannot turn itself on.
 */
export function agentVerdict(id: string, prev: unknown, next: unknown, trusted: boolean): Verdict {
  const row = classOf(id);
  if (!row || row.class === "secret") return "refuse";
  const narrows = !!row.narrows && row.narrows(prev, next);
  if (row.class === "low" || narrows) return "apply";
  if (row.class === "personOnly") return "refuse";
  return trusted ? "apply" : "ask";
}

/** A request as the window shows it: every word of it written by the server. */
export interface SettingRequestView {
  id: string;
  setting: string;
  label: string;
  root?: string;
  who: string;
  diff: string[];
  at: number;
  expires: number;
}
