import { describe, expect, test } from "bun:test";
import { activityReducer, agentAskRefusal, type Activity } from "../src/lib/browserAgentActivity.ts";
import { HANDOFF_OPEN_VERBS, handoffRefusal } from "../../shared/browserHandoff.ts";

/* During a handoff the agent stays attached, so its clicks and typing reached
   the page the person was using — it could even press Done. Now every acting
   verb on that tab is refused, from any caller; reading and the handoff's own
   check and cancel stay open. */
const armed = (): Activity => {
  let s = activityReducer({}, { type: "begin", tab: "t1", agent: "chk", op: "handoff" });
  s = activityReducer(s, { type: "end", tab: "t1", action: null });
  return activityReducer(s, { type: "handoff", tab: "t1", on: true });
};
const ask = (op: string, args: Record<string, unknown> = {}) => ({ op, args });

describe("a tab in handoff", () => {
  const acts = ["click", "dblclick", "fill", "type", "press", "select", "check", "upload", "drag",
    "open", "back", "forward", "reload", "eval", "scroll", "hover", "cookies", "storage", "cdp", "some-new-verb"];
  for (const op of acts) {
    test(`refuses ${op}, from the agent and from anybody else`, () => {
      expect(agentAskRefusal(armed().t1, ask(op, { as: "chk" }))).toContain("handoff");
      expect(agentAskRefusal(armed().t1, ask(op, { as: "other" }))).not.toBeNull();
      expect(agentAskRefusal(armed().t1, ask(op))).not.toBeNull();
    });
  }
  for (const op of ["observe", "read", "markdown", "shot", "console", "network"]) {
    test(`lets ${op} through`, () => expect(agentAskRefusal(armed().t1, ask(op, { as: "chk" }))).toBeNull());
  }
  test("lets the handoff's own check and cancel through", () => {
    expect(agentAskRefusal(armed().t1, ask("handoff", { check: true }))).toBeNull();
    expect(agentAskRefusal(armed().t1, ask("handoff", { cancel: true }))).toBeNull();
  });
  test("the sentence names the handoff and what to do", () => {
    const msg = handoffRefusal("click")!;
    expect(msg).toBe('this tab is handed to the person (handoff): "click" would act on the page they are using, so it is refused. '
      + "Wait for the handoff to end (the person presses Done, its --until is met, or it times out), "
      + "or cancel it (the handoff verb with cancel); reading the page still works.");
  });
  test("refusals add nothing to the person's log: the ask is answered before it begins", () => {
    /* The panel answers a refusal and returns before `begin`/`end`; the only way
       a row is written is `end` with an action. A refused act leaves state as is. */
    const s = armed();
    expect(agentAskRefusal(s.t1, ask("click", { selector: "#done" }))).not.toBeNull();
    expect(s.t1!.log).toEqual([]);
    expect(s.t1!.working).toBe(0);
  });
  test("the open list is reading only", () => {
    for (const op of ["click", "fill", "type", "press", "open", "eval", "reload", "back", "forward", "upload", "drag", "select", "check"]) {
      expect(HANDOFF_OPEN_VERBS.has(op)).toBe(false);
    }
  });
  test("a tab with no handoff is not touched", () => {
    const s = activityReducer({}, { type: "begin", tab: "t1", agent: "chk", op: "click" });
    expect(agentAskRefusal(s.t1, ask("click"))).toBeNull();
    expect(agentAskRefusal(undefined, ask("click"))).toBeNull();
  });
});
