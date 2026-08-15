/*
 * What a visit to the card picker would actually change.
 *
 * Two rules, and they are the whole file. Only differences count — a card
 * already in Code Review being "moved" to Code Review is not a change, and
 * leaving yourself on it is not an assignment — and what is announced is what
 * is sent: the summary somebody accepts is built from the same object the write
 * is built from, so the two cannot drift.
 *
 * They did drift. The confirmation read "move it to Code Review, put Ana
 * on it, take you off it"; one write landed, the other two were refused, and
 * the app said it had gone well. Now there is one plan, and the writer takes
 * the plan.
 */

/** What changes, and how it reads. Empty `lines` means: send nothing. */
export type CardPlan = {
  /** ClickUp user ids to put on the card. */
  add: number[];
  /** ClickUp user ids to take off it. */
  drop: number[];
  /** The status to move to, or "" to leave it where it is. */
  status: string;
  /** One line per change, in the order they will be applied. */
  lines: string[];
};

/**
 * The plan for a card, from what is ticked now against what was ticked when it
 * was read.
 *
 * `pick` is already "no change" when it holds the card's current status — the
 * picker never writes the status the card is in — but it is checked here too,
 * because this is where the rule belongs and a second caller will not know it.
 */
export function cardPlan(input: {
  /** The human card id, for the summary: `ORBIT-1042`. */
  label: string;
  /** The status chosen, or "" for "leave it where it is". */
  pick: string;
  /** The status the card is in now. */
  statusNow?: string;
  /** Who is ticked now, and who was on the card when it was read. */
  on: Iterable<number>;
  was: Iterable<number>;
  /** How to name a person in the summary. */
  nameOf: (id: number) => string;
}): CardPlan {
  const on = new Set(input.on);
  const was = new Set(input.was);
  const add = [...on].filter((id) => !was.has(id));
  const drop = [...was].filter((id) => !on.has(id));
  const status = input.pick && input.pick !== (input.statusNow ?? "") ? input.pick : "";

  const lines: string[] = [];
  if (status) lines.push(`Move ${input.label} to ${status}`);
  if (add.length) lines.push(`Put ${add.map(input.nameOf).join(", ")} on the card`);
  if (drop.length) lines.push(`Take ${drop.map(input.nameOf).join(", ")} off the card`);
  return { add, drop, status, lines };
}

/** Said once, after the write, in the words of what was asked for. */
export function cardPlanNote(plan: CardPlan, label: string): string {
  if (!plan.lines.length) return `${label} — nothing to change`;
  const bits: string[] = [];
  if (plan.status) bits.push(`moved to ${plan.status}`);
  if (plan.add.length) bits.push(`${plan.add.length} on`);
  if (plan.drop.length) bits.push(`${plan.drop.length} off`);
  return `${label} — ${bits.join(", ")}`;
}
