/*
 * "Tell them it is ready" goes to a tmux tab, and it is not a message to paste.
 *
 * Two rules from use, both easy to undo by accident later.
 *
 * The destination: work that runs is handed to a tmux window with an agent on
 * it, never to the chat pane — a message going into somebody else's Slack is
 * exactly the kind you want attached, where you can read it before it is sent
 * and take the keyboard off it.
 *
 * The wording: the box in the sidebar holds the FACTS — which pull request, its
 * number, its link, who it is for — written in this app's English. What lands
 * in Slack has to read like the channel it lands in, so the prompt tells the
 * agent to read the recent messages there and match them. Pasting this text is
 * the failure, not the fallback.
 *
 * Read off the source because the button is buried in PrPanel's sidebar and the
 * component has no seam to render it from; what is pinned here is the contract,
 * not the pixels.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

/** The Slack branch of the send button, from the `if` to its `return`. */
const slackBranch = (() => {
  const from = src.indexOf('if (tell === "slack") {');
  expect(from, "the Slack branch of the send button moved").toBeGreaterThan(-1);
  return src.slice(from, src.indexOf("return;", from));
})();

/** The body of `slackPrompt`. */
const prompt = (() => {
  const from = src.indexOf("function slackPrompt(");
  expect(from, "slackPrompt moved").toBeGreaterThan(-1);
  return src.slice(from, src.indexOf("\n}", from));
})();

describe("pinging Slack about a pull request", () => {
  it("opens a tmux tab with an agent on it", () => {
    expect(slackBranch).toContain("requestTermIssue(");
    expect(slackBranch).toContain("`slack-${d.number}`");
  });

  it("does not hand it to the chat pane", () => {
    expect(slackBranch).not.toContain("seedChat");
  });

  it("starts an agent rather than a bare shell", () => {
    // The fourth argument of requestTermIssue: false there opens a shell and
    // leaves the message sitting in nobody's hands.
    expect(slackBranch).toContain("slackPrompt(msg, target?.name), true,");
  });

  it("tells the agent the text is the facts, not the words", () => {
    expect(prompt).toContain("Not in these words");
    expect(prompt.toLowerCase()).toContain("do not paste");
  });

  it("tells it to match the channel it is posting in", () => {
    expect(prompt).toContain("read back through the recent messages");
    expect(prompt).toContain("their language");
  });

  it("still carries the message the sidebar composed", () => {
    expect(prompt).toContain("msg");
  });
});
