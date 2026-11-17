/*
 * Saying Go on a flight plan, once.
 *
 * Go is the most expensive press on this phone: it launches a builder and
 * spends a worker. The hold in `confirmPolicy.ts` is what a thumb has to mean;
 * this is what a NETWORK has to survive. A second press while the first is
 * still out would be two launches from one plan, and the server has no rule
 * against it — the first Go moves the plan to `go`, and the second finds it
 * there. So the phone refuses the second press itself, in the same words
 * everywhere, and only asks again after an answer it did not like.
 *
 * Pure, because a double press is the kind of thing a test can hold and a
 * screen cannot: `pressGo` is the whole decision, `afterGo` is what one answer
 * of the route means.
 */
import { modelLabel } from "../../../shared/builderModel.ts";
import type { PlanWaiting } from "./inbox.ts";

/** `ready` is "nothing is in flight"; `posting` is "one Go is out and its
 *  answer has not come"; `sent` is "the plan took it", which is the end of this
 *  card's life. */
export type GoPhase = "ready" | "posting" | "sent";

export interface Press {
  /** Whether this press may reach the computer. */
  post: boolean;
  /** What to say when it may not. One line, one home. */
  said?: string;
}

export const IN_FLIGHT = "Go is already on its way. Wait for the computer's answer.";
export const NO_PLAN = "This plan has already been decided.";

/** What a press on Go does to the phase. Two presses, one request. */
export function pressGo(phase: GoPhase): Press {
  if (phase === "posting") return { post: false, said: IN_FLIGHT };
  if (phase === "sent") return { post: false, said: NO_PLAN };
  return { post: true };
}

/** What the route's answer says about the card. A Go the server could not
 *  START the builder for still moved the plan, so the card says the reason
 *  rather than pretending nothing happened — and stays pressable, because the
 *  launch is still there to try again. */
export interface GoAnswer {
  ok: boolean;
  error?: string;
  /** `ok: true` in the body: the plan took the decision. */
  took?: boolean;
  launchError?: string;
  queued?: boolean;
  /** Where the builder started, when it did. */
  where?: string;
}

export function afterGo(answer: GoAnswer): { phase: GoPhase; said?: string } {
  if (!answer.ok) return { phase: "ready", said: answer.error || "The computer did not take that." };
  if (!answer.took) return { phase: "ready", said: answer.error || "The plan did not take that." };
  if (answer.launchError) return { phase: "ready", said: answer.launchError };
  if (answer.queued) return { phase: "sent", said: "Go is recorded. A builder starts as soon as one lands." };
  return { phase: "sent", said: answer.where ? `Go — building in ${answer.where}.` : "Go. The builder is starting." };
}

/**
 * The line the card shows above the buttons: which model Go starts, and why.
 *
 * The plan picks the model, not the person's last mood (`shared/builderModel.ts`
 * decides), so this reads the `launch` the list route computed and never
 * guesses one. A plan the route sent no launch for is a launched plan, which
 * does not reach this card.
 */
export function launchLine(plan: PlanWaiting): string {
  const model = plan.launch?.model;
  if (!model) return "The builder starts on the model this project set for the builder role.";
  const why = plan.launch?.why?.trim();
  return `${modelLabel(model)}${why ? ` · ${why}` : ""}`;
}
