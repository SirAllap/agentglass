/*
 * "Tell them it is ready": where it goes, and whose words it is written in.
 *
 * Three rules from use, all easy to undo by accident later.
 *
 * The destination: work that runs is handed to a tmux window with an agent on
 * it, never to the chat pane — a message going into somebody else's Slack is
 * exactly the kind you want attached, where you can read it before it is sent.
 *
 * The wording: NOT in this file, and not anywhere in this repository. It is a
 * prompt in the catalogue, edited in Settings and stored in the user's own
 * file, because what you say to a colleague is as personal as it gets and an
 * app update must not rewrite it.
 *
 * The facts it is given: who it is for, the card's address and whatever was
 * typed in the box — the three the shipped frame is built around, and the ones
 * a context assembled by hand quietly forgets.
 *
 * Read off the source: the button is buried in PrPanel's sidebar and the
 * component has no seam to render it from, so what is pinned is the contract.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

/** The Slack branch of the send button, from the `if` to its `return`. */
const slackBranch = (() => {
  const from = src.indexOf('if (tell === "slack") {');
  expect(from, "the Slack branch of the send button moved").toBeGreaterThan(-1);
  return src.slice(from, src.indexOf("return;", from));
})();

/** The body of `pingPrompt`. */
const pingPrompt = (() => {
  const from = src.indexOf("function pingPrompt(");
  expect(from, "pingPrompt moved").toBeGreaterThan(-1);
  return src.slice(from, src.indexOf("\n}", from));
})();

describe("pinging somebody about a pull request", () => {
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
    expect(slackBranch).toContain("text, true, false,");
  });

  it("takes its wording from the catalogue, not from this file", () => {
    expect(pingPrompt).toContain("recipes.find((x) => x.id === PING_RECIPE)");
    expect(src).toContain('const PING_RECIPE = "ready-for-review"');
  });

  it("expands the prompt with the shared table, so {card} cannot mean two things", () => {
    expect(src).toContain('import { expandRecipe } from "../../../shared/recipeText.ts"');
    expect(pingPrompt).toContain("expandRecipe(body, ctx)");
  });

  it("still says something when the catalogue has no such prompt", () => {
    // Deleted, or simply not fetched yet — the button must not go quiet.
    expect(pingPrompt).toContain("FALLBACK_PING");
    expect(src).toContain("const FALLBACK_PING = [");
  });

  it("gives it who it is for, the card's address and what was typed", () => {
    expect(slackBranch).toContain("who: target?.name ?? \"\"");
    expect(slackBranch).toContain("cardUrl: task?.url");
    expect(slackBranch).toContain("note: msg.trim()");
  });

  it("does not prefill the box for Slack — that message is the agent's to write", () => {
    // On the card the box IS the note and keeps its default. Prefilling it for
    // Slack put this app's English into somebody's DM.
    const btn = src.slice(src.indexOf('setTell(tell === "slack"'), src.indexOf("Ping Slack"));
    expect(btn).toContain('setMsg("")');
    expect(btn).not.toContain("defaultPing");
  });
});
