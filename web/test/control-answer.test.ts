/*
 * When a window answers a command that asked for one. Every window receives the
 * frame and the server settles on the first reply, so a window nobody is looking
 * at waits a beat; a command that asked nothing sends nothing.
 */
import { describe, expect, it } from "bun:test";
import { answerControl, answerDelayMs, HIDDEN_ANSWER_DELAY_MS } from "../src/lib/controlAnswer.ts";

const reply = { ok: true, applied: true, value: { state: {}, untrusted: {} } };

describe("answerControl", () => {
  it("a visible window answers at once, with the id and the reply", () => {
    const sent: unknown[] = [];
    answerControl("c1-x", reply, (r) => { sent.push(r); return Promise.resolve(); }, false);
    expect(sent).toEqual([{ rid: "c1-x", ...reply }]);
  });

  it("a command with no request id sends nothing", () => {
    const sent: unknown[] = [];
    answerControl(undefined, reply, (r) => { sent.push(r); return Promise.resolve(); }, false);
    expect(sent).toEqual([]);
  });

  it("a hidden window lets a visible one go first, and still answers if it is the only one", async () => {
    expect(answerDelayMs(false)).toBe(0);
    expect(answerDelayMs(true)).toBe(HIDDEN_ANSWER_DELAY_MS);
    const sent: unknown[] = [];
    answerControl("c2-y", reply, (r) => { sent.push(r); return Promise.resolve(); }, true);
    expect(sent).toEqual([]);
    await Bun.sleep(HIDDEN_ANSWER_DELAY_MS + 100);
    expect(sent).toHaveLength(1);
  });

  it("a refused post (the wait ran out) is swallowed", async () => {
    answerControl("c3-z", reply, () => Promise.reject(new Error("504")), false);
    await Bun.sleep(10);
  });
});
