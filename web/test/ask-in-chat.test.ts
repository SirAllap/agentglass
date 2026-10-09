import { beforeEach, describe, expect, it } from "bun:test";
import { askInChatVisible, forgetSlackReach, slackReach, REACH_TTL_MS } from "../src/lib/askInChat.ts";

/*
 * "Ping in chat" without a card.
 *
 * The button sat inside the ClickUp section, behind the early return that
 * draws nothing for a pull request with no card id. So a machine with no
 * tracker, or a branch that simply carried no id, could not ask a colleague
 * for a review even with Slack connected to the agent. The section is now its
 * own, gated on the agent's reach alone.
 */
const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

/** One top-level function's body: a `function` at column zero is the next one. */
const bodyOf = (name: string) => {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `no function ${name}`).toBeGreaterThan(-1);
  const j = src.indexOf("\nfunction ", i + 1);
  return src.slice(i, j === -1 ? undefined : j);
};

describe("when the section is drawn", () => {
  it("is drawn with chat reach and no card", () => {
    expect(askInChatVisible({ slack: true, card: false })).toBe(true);
  });
  it("is drawn with chat reach and a card", () => {
    expect(askInChatVisible({ slack: true, card: true })).toBe(true);
  });
  it("is hidden without chat reach, card or not", () => {
    expect(askInChatVisible({ slack: false, card: false })).toBe(false);
    expect(askInChatVisible({ slack: false, card: true })).toBe(false);
  });
});

describe("how often reach is asked", () => {
  beforeEach(() => forgetSlackReach());
  it("asks once for the pull requests opened inside the TTL", async () => {
    let calls = 0;
    const ask = async () => { calls++; return { slack: true }; };
    expect(await slackReach(ask, 1000)).toBe(true);
    expect(await slackReach(ask, 1000 + REACH_TTL_MS - 1)).toBe(true);
    expect(calls).toBe(1);
    expect(await slackReach(ask, 1000 + REACH_TTL_MS)).toBe(true);
    expect(calls).toBe(2);
  });
  it("reads a failure as no, and asks again next time", async () => {
    let calls = 0;
    const boom = async () => { calls++; throw new Error("down"); };
    expect(await slackReach(boom, 5)).toBe(false);
    expect(await slackReach(boom, 6)).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("where the section lives in the panel", () => {
  const ask = bodyOf("AskInChat");
  const facts = bodyOf("CardFacts");

  it("is gated on the helper, with no card in the way", () => {
    expect(ask).toContain("askInChatVisible({ slack, card: !!ref })");
    // The card is optional: nothing in the gate returns early on a missing ref.
    expect(ask).not.toContain("if (!ref) return null");
  });
  it("runs every hook before its one early return", () => {
    const at = ask.indexOf("if (!askInChatVisible(");
    expect(at).toBeGreaterThan(-1);
    expect(/\buse[A-Z]\w*\(/.exec(ask.slice(at))?.[0] ?? "none").toBe("none");
  });
  it("is its own section, not a child of the ClickUp one", () => {
    expect(ask).toContain('<SidebarSection title="Ask for review">');
    expect(ask).not.toContain('title="ClickUp"');
    const sidebar = bodyOf("PrSidebar");
    expect(sidebar).toContain("<AskInChat d={d} root={root} />");
    expect(sidebar.indexOf("<AskInChat")).toBeGreaterThan(sidebar.indexOf("<CardFacts"));
  });
  it("leaves the card section with the note only", () => {
    expect(facts).not.toContain("notifyReach");
    expect(facts).not.toContain("Ping in chat");
    expect(facts).not.toContain('"slack"');
    expect(facts).not.toContain("requestTermIssue");
    expect(facts).toContain("Note on card");
  });
  it("is labelled for chat, not for one product", () => {
    expect(ask).toContain("Ping in chat");
    expect(ask).not.toContain("Ping Slack");
  });
  it("sends an empty card when there is none, and the wording stays the user's", () => {
    expect(ask).toContain('card: ref?.label ?? ""');
    expect(ask).toContain('cardUrl: task?.url || ""');
    expect(ask).toContain("pingPrompt(recipes,");
  });
});
