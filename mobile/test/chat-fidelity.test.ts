/*
 * "I lose information in the chat when it is touching code files."
 *
 * Literally true, and the mechanism is exact. The feed was built from the
 * newest 120 timeline entries, and a tool run IS an entry — so a turn that
 * touched forty files spent the whole budget on tool rows and evicted every
 * message. The harder the agent worked, the less of what it said survived,
 * which is precisely backwards.
 *
 * Three more things were being dropped on the way to the screen, all of them
 * already in the payload the phone had fetched: what a tool answered, which
 * subagent ran it, and the difference between a turn that was interrupted and
 * an agent that said "[Request interrupted by user]" to you in its own voice.
 */
import { describe, expect, test } from "bun:test";
import { buildFeed, type FeedEntry } from "../src/model/transcript.ts";

// Newest first, the way the server sends it.
const msg = (ts: number, text: string, role: "user" | "assistant" = "assistant"): FeedEntry =>
  ({ kind: "message", ts, role, text });
const tool = (ts: number, over: Partial<FeedEntry> = {}): FeedEntry =>
  ({ kind: "tool", ts, tool: "Edit", target: "a.ts", ...over });

describe("a busy agent cannot silence itself", () => {
  test("messages survive a turn made entirely of tool runs", () => {
    /*
     * The complaint, as a test. Three hundred tool runs newer than the last
     * thing the agent said: under a flat window every single message is
     * evicted and the conversation renders as nothing but grey blocks.
     */
    const timeline: FeedEntry[] = [
      ...Array.from({ length: 300 }, (_, i) => tool(1000 - i)),
      msg(600, "Here is what I found."),
      msg(599, "Have a look at the egress path.", "user"),
    ];
    const feed = buildFeed(timeline, 120);
    const texts = feed.filter((f) => f.kind === "message").map((f) => (f as { text: string }).text);
    expect(texts).toEqual(["Have a look at the egress path.", "Here is what I found."]);
  });

  test("the tool budget is what gets spent, not the message budget", () => {
    const timeline = Array.from({ length: 300 }, (_, i) => tool(1000 - i));
    const runs = buildFeed(timeline, 120)
      .filter((f) => f.kind === "tools")
      .reduce((n, f) => n + (f as { runs: unknown[] }).runs.length, 0);
    // limit 120 minus the 50 held back for messages.
    expect(runs).toBe(70);
  });

  test("a floor larger than the window does not widen the window", () => {
    // A caller asking for ten entries must get ten.
    const timeline = Array.from({ length: 200 }, (_, i) => msg(1000 - i, `m${i}`));
    expect(buildFeed(timeline, 10)).toHaveLength(10);
  });

  test("the newest end is kept, and drawn oldest first", () => {
    const timeline = Array.from({ length: 200 }, (_, i) => msg(1000 - i, `m${i}`));
    const feed = buildFeed(timeline, 3) as { text: string }[];
    expect(feed.map((f) => f.text)).toEqual(["m2", "m1", "m0"]);
  });
});

describe("what the tool answered", () => {
  test("output survives into the feed", () => {
    // It has been on the wire the whole time (TimelineEntry.output). Without
    // it a failing test and a passing one look identical, which is what still
    // sent you to the terminal.
    const feed = buildFeed([tool(1, { tool: "Bash", target: "bun test", output: "3 fail", is_error: true, output_clipped: true })]);
    const runs = (feed[0] as { runs: { output?: string; output_clipped?: boolean; is_error?: boolean }[] }).runs;
    expect(runs[0]!.output).toBe("3 fail");
    expect(runs[0]!.output_clipped).toBe(true);
    expect(runs[0]!.is_error).toBe(true);
  });

  test("the link to a diff survives too", () => {
    const feed = buildFeed([tool(1, { tool_use_id: "tu_9" })]);
    expect((feed[0] as { runs: { tool_use_id?: string | null }[] }).runs[0]!.tool_use_id).toBe("tu_9");
  });
});

describe("subagents are not flattened into the main thread", () => {
  test("a subagent's runs form their own block", () => {
    // Every subagent turn reports the PARENT's session id, so without the tag
    // four agents working in parallel read as one very busy one.
    const feed = buildFeed([
      tool(3, { agent_id: "a1", agent_type: "reviewer" }),
      tool(2, { agent_id: "a1", agent_type: "reviewer" }),
      tool(1),
    ]);
    expect(feed).toHaveLength(2);
    expect((feed[0] as { agent?: string | null }).agent).toBeNull();
    expect((feed[1] as { agent?: string | null }).agent).toBe("reviewer");
  });

  test("two different subagents do not merge", () => {
    const feed = buildFeed([
      tool(2, { agent_id: "b", agent_type: "tests" }),
      tool(1, { agent_id: "a", agent_type: "docs" }),
    ]);
    expect(feed).toHaveLength(2);
  });
});

describe("transcript bookkeeping is not conversation", () => {
  test("an interrupt becomes a note, not something the agent said", () => {
    const feed = buildFeed([msg(2, "[Request interrupted by user]"), msg(1, "Working on it.")]);
    expect(feed.map((f) => f.kind)).toEqual(["message", "note"]);
    expect((feed[1] as { text: string }).text).toBe("You interrupted this turn");
  });

  test("it is kept rather than dropped", () => {
    // Losing it would make the gap in the conversation inexplicable — the turn
    // really did stop, and that is worth one line.
    expect(buildFeed([msg(1, "No response requested.")])).toHaveLength(1);
  });

  test("ordinary text that merely mentions one is untouched", () => {
    const feed = buildFeed([msg(1, "You will see [Request interrupted by user] in the log.")]);
    expect(feed[0]!.kind).toBe("message");
  });
});

/*
 * A fifth describe covered `permissionMode.ts` — that a chat started from a
 * phone opens on `acceptEdits`, because `default` under `claude -p` refuses any
 * tool that would raise a dialog and a phone is exactly where you cannot answer
 * one per edit. It went with the browser companion, which is the only surface
 * that ever offered the picker.
 *
 * Worth reading before this app grows one: `app/chat/[id].tsx` sends
 * `mode: "default"` today, deliberately (a phone is for replying, not for
 * turning an agent loose), and that is the SAME literal the companion was made
 * to stop hardcoding. If a composer ever appears here, that decision has to be
 * made again on purpose rather than inherited from this line.
 */
