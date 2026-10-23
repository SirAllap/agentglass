/*
 * What a Jira step will do, as the rows its confirmation draws. One row per
 * block, in the order the server runs them (the move, then who is on the card,
 * then the comment, then the link), whatever order the blocks were saved in.
 *
 * Everything here is read from facts the panel already holds: the card's status,
 * its assignee, whether the pull request is already among its links. There is no
 * request and no write; a row that those facts say would change nothing carries
 * `noop` with the reason, so the dialog says "nothing happens" before the press
 * instead of after it.
 *
 * Ceiling: the server decides at the moment it runs, from a fresh read. A card
 * that changed since the panel looked can still turn a row that was a change
 * into a skip (or the other way); the answer's own per-block list is what the
 * dialog settles on afterwards, never this one.
 */
import { fillTemplate, planOf, type Placeholder } from "../../../shared/stepBlocks.ts";
import type { JiraBlockOutcome, JiraHandoffRule, JiraStepChoice, JiraStepPr, StepBlock } from "../../../shared/providers.ts";
import { NO_ASSIGN } from "./stepAssign.ts";

export interface PlanPerson {
  /** The id a card's people carry, so who is on the card compares with who a step names. */
  key: string;
  /** What a write sends when it differs from `key` (Data Center's login); the question's choice is in this form. */
  writeKey?: string;
  name: string; initials: string; avatar?: string; color?: string; me?: boolean;
}

export interface PlanInput {
  blocks: readonly StepBlock[];
  card: { key: string; title: string; status: string; statusColor?: string; assignee: PlanPerson | null };
  /** The status the move reaches: fixed by the step, or what the person picked. Null while it is still to be picked. */
  target: string | null;
  /** What the person chose in the question, as the press will send it. */
  choice: JiraStepChoice;
  pr?: JiraStepPr | undefined;
  /** Is the pull request already one of the card's links? Null when that has not been read. */
  linked: boolean | null;
  /** Your name on the site, when the panel knows it; `{me}` stays as written when not. */
  me?: string;
  /** The people a card can be given to, to put a face to a key. */
  people?: readonly PlanPerson[];
}

export type RowKind = "move" | "unassign" | "assign" | "comment" | "link";
/** The key the server's per-block answer uses for this row: the take-off and the assign share `assignee`. */
export type OutcomeKey = JiraBlockOutcome["block"];

export interface PlanRow {
  id: string;
  kind: RowKind;
  outcome: OutcomeKey;
  sentence: string;
  /** The row's effect, below the sentence: the comment's text, the link's rule. */
  detail?: string;
  /** Why this row would change nothing, or null when it will. */
  noop: string | null;
  /** Whom the row is about, drawn as faces with names beside the sentence. */
  people: PlanPerson[];
  /** Something to know that is not a reason: an unfilled placeholder. */
  note?: string;
  /** The row as a verb phrase, for the button that confirms: "move to In Review". */
  phrase: string;
}

/**
 * A colour for a person with no picture, the way ClickUp gives each member one: the same name is the same colour
 * every time, and white initials on it clear 4.5:1 in either theme (lightness 38, so no name lands on a pale one).
 */
export const tintOf = (name: string): string => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 38%)`;
};

const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** A person on the card, as the rows draw them. A person with no key cannot be told apart, so is not one. */
export function onCard(p: { key?: string; id?: number; name: string; initials?: string; avatar?: string; color?: string; me?: boolean } | undefined): PlanPerson | null {
  const key = p?.key ?? (p?.id != null ? String(p.id) : "");
  if (!p || !key) return null;
  return { key, name: p.name, initials: p.initials || initialsOf(p.name), ...(p.avatar ? { avatar: p.avatar } : null), color: p.color || tintOf(p.name), ...(p.me ? { me: true } : null) };
}

/** A person the card can be given to: `id` is who a card carries, `key` what a write sends. */
export function assignable(p: { key: string; id: string; name: string; avatar?: string }): PlanPerson {
  return { key: p.id, writeKey: p.key, name: p.name, initials: initialsOf(p.name), ...(p.avatar ? { avatar: p.avatar } : null), color: tintOf(p.name) };
}

/** The same pull request, spelled the way a link and a card's own address may differ in: case, a slash, a query. */
const canon = (u: string): string => { try { const x = new URL(u); return `${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}`; } catch { return u.trim().toLowerCase(); } };

/** Is the pull request already one of the card's links? Null when the links could not be read: nothing is claimed. */
export function alreadyLinked(links: { links: readonly { url: string }[]; error: string }, url: string): boolean | null {
  if (links.error) return null;
  return links.links.some((l) => canon(l.url) === canon(url));
}

const RUN_ORDER: RowKind[] = ["move", "unassign", "assign", "comment", "link"];
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function planRows(i: PlanInput): PlanRow[] {
  const plan = planOf<string | number>("move", { enabled: true, statusNames: [], assign: NO_ASSIGN, blocks: [...i.blocks] });
  const { card, choice } = i;
  const known = [...(i.people ?? []), ...(card.assignee ? [card.assignee] : [])];
  const me = known.find((p) => p.me);
  const find = (key: string) => known.find((p) => (p.writeKey ?? p.key) === key || p.key === key);
  const on = card.assignee;
  const rows: PlanRow[] = [];

  // What the assign block writes, which decides whether a take-off still has a say.
  let given: PlanPerson | null | undefined; // undefined: leaves it; null: nobody
  let givenWhy: string | null = null;
  const asks = plan.askAssign;
  if (asks) {
    if (choice.assign === undefined) givenWhy = "Left as it is: nobody is picked";
    else given = choice.assign === null ? null : find(choice.assign) ?? { key: choice.assign, name: choice.assign, initials: "?" };
  } else if (plan.assign.who === "me") {
    given = me; givenWhy = me ? null : "Jira picks you when it runs";
  } else if (plan.assign.who === "person" && plan.assign.person) {
    given = find(String(plan.assign.person.id)) ?? { key: String(plan.assign.person.id), name: plan.assign.person.name, initials: initialsOf(plan.assign.person.name), color: tintOf(plan.assign.person.name) };
  } else if (plan.assign.who === "author") {
    givenWhy = "The pull request's author has no Jira account to match, so nobody is set";
  }
  const hasAssign = !!asks || plan.assign.who !== "none";
  const writes = given !== undefined && !(given && on && given.key === on.key) && !(given === null && !on);

  if (plan.move) {
    const to = i.target;
    rows.push({
      id: "move", kind: "move", outcome: "move", people: [],
      sentence: to ? `Move ${card.key} from ${card.status || "no status"} to ${to}` : `Move ${card.key} to the status you pick`,
      phrase: to ? `move to ${to}` : "move it",
      noop: to && same(to, card.status) ? `Already in ${card.status}, so this does nothing` : null,
    });
  }

  const un = plan.askUnassign;
  const fixedOff = plan.takeOff;
  if (un || fixedOff.length || plan.unassign !== "none") {
    const who = un ? un.who : fixedOff.length ? "people" : plan.unassign;
    const named = un ? un.people : fixedOff;
    const names = who === "people" ? named.map((p) => p.name).join(", ") : "";
    let noop: string | null = null;
    if (!on) noop = "Nobody is on the card, so there is nothing to take off";
    else if (who === "me" && !on.me) noop = "You are not on the card, so there is nothing to take off";
    else if (who === "people" && !named.some((p) => String(p.id) === on.key)) noop = `${names || "Nobody named"} ${named.length > 1 ? "are" : "is"} not on the card, so there is nothing to take off`;
    else if (un && choice.clear !== true) noop = `You chose to leave ${on.name} on the card`;
    else if (writes && given) noop = `Replaced by giving the card to ${given.name}`;
    rows.push({
      id: "unassign", kind: "unassign", outcome: "assignee", people: on ? [on] : [],
      sentence: on ? `Take ${on.name} off the card` : "Take the assignee off the card", noop, phrase: "take the assignee off",
    });
  }

  if (hasAssign) {
    const noop = given === undefined ? givenWhy
      : given === null ? (on ? null : "Nobody is on the card, so there is nothing to take off")
        : on && given.key === on.key ? `${given.name} is already on the card` : null;
    rows.push({
      id: "assign", kind: "assign", outcome: "assignee", people: given ? [given] : [],
      sentence: given === null ? "Take the assignee off the card" : given ? `Assign the card to ${given.name}` : "Assign the card",
      noop, phrase: given === null ? "take the assignee off" : given ? `assign ${given.name}` : "assign it",
    });
  }

  if (plan.comment) {
    const text = plan.comment.ask && choice.comment !== undefined ? choice.comment : plan.comment.text;
    const filled = fillTemplate(text, {
      ...(i.pr ? { pr: `${i.pr.number ? `#${i.pr.number} ` : ""}${i.pr.title ?? ""}`.trim(), pr_url: i.pr.url } : null),
      ...(i.pr?.author ? { author: i.pr.author } : null),
      ...((i.target ?? card.status) ? { status: (i.target ?? card.status) } : null),
      ...(i.me ?? me?.name ? { me: (i.me ?? me?.name)! } : null),
    } satisfies Partial<Record<Placeholder, string>>);
    rows.push({
      id: "comment", kind: "comment", outcome: "comment", people: [], sentence: `Comment on ${card.key}`, detail: filled.text, noop: null, phrase: "comment",
      ...(filled.missing.length ? { note: `${filled.missing.map((m) => `{${m}}`).join(", ")} ${filled.missing.length > 1 ? "are" : "is"} filled in ${filled.missing[0] === "me" ? "with your Jira name " : ""}when it runs` } : null),
    });
  }

  if (plan.link) {
    const label = i.pr?.number ? `pull request #${i.pr.number}` : "the pull request";
    rows.push({
      id: "link", kind: "link", outcome: "link", people: [], sentence: `Link ${label} on the card`,
      detail: "Once: nothing happens if it is already there", phrase: "link the pull request",
      noop: i.linked === true ? `${label.charAt(0).toUpperCase()}${label.slice(1)} is already on the card` : null,
    });
  }

  return rows.sort((a, b) => RUN_ORDER.indexOf(a.kind) - RUN_ORDER.indexOf(b.kind));
}

/**
 * What the confirm button says: the rows that will change something, as one phrase ("Move to In Review and link
 * the pull request"). Null when every row would change nothing, so there is nothing to confirm.
 */
export function actionLabel(rows: readonly PlanRow[]): string | null {
  const parts = [...new Set(rows.filter((r) => !r.noop).map((r) => r.phrase))];
  if (!parts.length) return null;
  const text = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A project's older hand-off rule as the blocks it behaves like: the server runs that rule instead of the step's
 * blocks for such a project, and the dialog shows the same rows either way.
 */
export function ruleBlocks(r: JiraHandoffRule): StepBlock[] {
  return [
    ...(r.to || r.askTo ? [{ type: "move" as const, statusNames: r.to ? [r.to.name] : [], ...(r.askTo ? { ask: true as const } : null) }] : []),
    ...(r.clear || r.askClear ? [{ type: "unassign" as const, who: "all" as const, ...(r.askClear ? { ask: true as const } : null) }] : []),
  ];
}

// --- settling the rows from what the server answered ----------------------------

export type RowState = "waiting" | "running" | "done" | "failed" | "skipped";
export type Phase = "idle" | "running" | "finished";
export interface Settled { row: PlanRow; state: RowState; /** A sentence of ours for a skip or a failure. */ why?: string }
export interface StepAnswer { ok: boolean; error?: string; conflict?: boolean; unauthorised?: boolean; blocks?: readonly JiraBlockOutcome[] }

/**
 * One state per row. Before the press they wait, while the one request is in
 * flight they all run (the server runs them in order but says nothing until it
 * is done, so the dialog does not pretend to know which one it is on), and
 * after it each row is what the server said it was. A row the server never
 * mentioned was not run, which is never drawn as done. A refused run changed
 * nothing, so every row is "not run".
 */
export function settleRows(rows: readonly PlanRow[], phase: Phase, answer: StepAnswer | null): Settled[] {
  if (phase === "idle" || (phase === "finished" && !answer)) return rows.map((row) => ({ row, state: "waiting" }));
  if (phase === "running") return rows.map((row) => ({ row, state: "running" }));
  const a = answer!;
  if (!a.ok) return rows.map((row) => ({ row, state: "skipped", why: "not run" }));
  const by = new Map<OutcomeKey, JiraBlockOutcome>();
  for (const b of a.blocks ?? []) by.set(b.block, b);
  return rows.map((row): Settled => {
    const o = by.get(row.outcome);
    if (!o) return { row, state: "skipped", why: "not run" };
    return { row, state: o.state, ...(o.why ? { why: o.why } : null) };
  });
}

/**
 * One sentence for a run the server refused, always ending in what is true: nothing in Jira changed. Only
 * sentences this app writes are passed through; anything that could carry the site's own words is replaced.
 */
export function plainFailure(r: { ok?: boolean; error?: string; conflict?: boolean; unauthorised?: boolean }): string {
  const end = " Nothing in Jira was changed.";
  if (r.conflict) return `Somebody changed the card while this was open.${end}`;
  if (r.unauthorised) return `Jira did not accept the saved sign-in.${end}`;
  const e = r.error ?? "";
  if (/^Writing to Jira is switched off$/.test(e)) return `${e}.${end}`;
  if (/^Jira did not accept that move\. The card may have moved on, or you cannot move it$/.test(e)) return `${e}.${end}`;
  const already = /^[A-Z][A-Z0-9_]*-\d+ is already in (.{1,200})$/.exec(e);
  if (already) return `The card is already in ${already[1]}.${end}`;
  const nothing = /^Nothing to do for ([A-Z][A-Z0-9_]*-\d+)$/.exec(e);
  if (nothing) return `There was nothing to do for ${nothing[1]}.${end}`;
  if (e.startsWith("Nothing was changed: could not read the card's") || /did not answer|HTTP \d{3}|Could not reach/i.test(e)) return `Jira would not answer.${end}`;
  return `Jira refused it.${end}`;
}
