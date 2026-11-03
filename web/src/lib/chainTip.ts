/*
 * What the chain tooltip says, as plain data: the ladder a worker's engines run
 * in, the words on the connector between two steps, the rule that moved it, the
 * rounds and the two exits. Pure, so the tip is asserted without a renderer and
 * `TipHost` only paints it.
 *
 * The ladder is the chain in force, not the base one: a step a rule skipped is
 * not drawn as a step, it is named in the rule's box ("moved it from …"), which
 * is the only thing the app knows for certain.
 *
 * Its ceiling, stated: the app knows the fail arrow's cap, not how many rounds
 * were used, so the dots are the cap with none lit and the line says "up to N".
 * A measured count needs a live reading the flow does not carry.
 */
import type { Chain } from "../../../shared/orchestration.ts";
import { engineName } from "../components/orchestration/flow/flowScreenCopy.ts";

export const CHAIN_TIP_TITLE = "Who runs this block";
export const CHAIN_TIP_FOOTER = "Configure → Who does the work to change any of this.";
export const CHAIN_TIP_NO_FALLBACK = "No fallback: if this cannot start it asks you. Add one in Configure → Who does the work.";

export interface ChainTipStep {
  /** 1-based, the round circle's number. */
  n: number;
  engine: string;
  model: string;
  /** "Running now", "Main", or "Fallback 2": the pill at the right end. */
  tag: string;
  /** The step the board says is working: outlined, and not dimmed. */
  now: boolean;
  main: boolean;
}

export interface ChainTip {
  title: string;
  detail: string;
  /** "if it cannot start", on the dashed line before step 2. */
  gap: string;
  gapThen: string;
  steps: ChainTipStep[];
  /** One step and nothing behind it: the ladder says so instead of drawing a gap. */
  noFallback: string | null;
  /** The rule that moved the chain, and the engine it moved away from. */
  why: string | null;
  rounds: { of: number; dots: boolean[]; word: string } | null;
  ask: boolean;
  askWord: string;
  pass: string;
  fail: string;
  footer: string;
  /** More than four steps: the ladder scrolls inside the card and the footer stays. */
  scrolls: boolean;
}

export interface ChainTipInput {
  chain: Chain;
  /** The fail arrow's cap, or null when the role has no fail arrow. */
  rounds: number | null;
  ask: boolean;
  /** At least one row of this role is working now. */
  running: boolean;
  pass: string;
  fail: string;
  /** The rule in force: its name, and the engine it moved away from. */
  rule: { name: string; was: string } | null;
}

export function chainTip(input: ChainTipInput): ChainTip {
  const steps: ChainTipStep[] = input.chain.map((s, i) => ({
    n: i + 1,
    engine: engineName(s.engine),
    model: s.model,
    tag: i === 0 && input.running ? "Running now" : i === 0 ? "Main" : `Fallback ${i}`,
    now: i === 0 && input.running,
    main: i === 0,
  }));
  const of = input.rounds;
  return {
    title: CHAIN_TIP_TITLE,
    detail: `${steps.length} ${steps.length === 1 ? "step" : "steps"}`,
    gap: "if it cannot start",
    gapThen: "if that cannot start either",
    steps,
    noFallback: steps.length < 2 ? CHAIN_TIP_NO_FALLBACK : null,
    why: input.rule ? `Rule “${input.rule.name}” moved it from ${input.rule.was}.` : null,
    rounds: of === null ? null : {
      of,
      dots: Array.from({ length: of }, () => false),
      word: `up to ${of} ${of === 1 ? "try" : "tries"} · then it ${input.ask ? "asks you" : "hands over to the next step"}`,
    },
    ask: input.ask,
    askWord: input.ask ? "On · it stops and lets you pick" : "Off",
    pass: input.pass,
    fail: input.fail,
    footer: CHAIN_TIP_FOOTER,
    scrolls: steps.length > 4,
  };
}
