/*
 * What a gate waiting on you's card says.
 *
 * The Now screen drew a gate as its summary and a line of `source_app · the
 * agent is stopped until you answer`. `source_app` is the project's label, so
 * on a machine with thirty worktrees of one project the line named none of
 * them. The server composes `where` from the pane note and tmux; the card
 * leads with it.
 */
import { describe, expect, test } from "bun:test";
import type { PendingGate } from "../../shared/types.ts";
import { gateAsk, gateDetail, gateWhere, gatesInOrder, waited } from "../src/model/gates.ts";

const gate = (over: Partial<PendingGate> = {}): PendingGate => ({
  id: "g1", source_app: "orbit", session_id: "s1", tool_name: "Bash",
  summary: "bun run db:migrate --force", created: 1_700_000_000_000, ...over,
});

describe("where", () => {
  test("is the window the server named", () => {
    expect(gateWhere(gate({ where: "orbit · 2 build" }))).toBe("orbit · 2 build");
  });
  test("falls back to the project, never to a slice of a session id", () => {
    expect(gateWhere(gate())).toBe("orbit");
    expect(gateWhere(gate({ where: "  " }))).toBe("orbit");
  });
});

describe("what it wants", () => {
  test("a Claude Code tool is a verb", () => {
    expect(gateAsk(gate())).toBe("Claude wants to run");
    expect(gateAsk(gate({ tool_name: "Edit" }))).toBe("Claude wants to edit");
  });
  test("anything else is named, not guessed at", () => {
    expect(gateAsk(gate({ tool_name: "mcp__acme__deploy" }))).toBe("Wants to use mcp__acme__deploy");
  });
  test("the exact ask is the summary, or the tool when there is none", () => {
    expect(gateDetail(gate())).toBe("bun run db:migrate --force");
    expect(gateDetail(gate({ summary: "" }))).toBe("Bash");
  });
});

describe("order and age", () => {
  test("the one that has waited longest comes first", () => {
    const got = gatesInOrder([gate({ id: "new", created: 3 }), gate({ id: "old", created: 1 })]);
    expect(got.map((g) => g.id)).toEqual(["old", "new"]);
  });
  test("minutes, hours, days", () => {
    const t = 1_700_000_000_000;
    expect(waited(t, t + 20_000)).toBe("now");
    expect(waited(t, t + 4 * 60_000)).toBe("4m");
    expect(waited(t, t + 3 * 3_600_000)).toBe("3h");
    expect(waited(t, t + 2 * 86_400_000)).toBe("2d");
  });
});

/*
 * "waited 3m" froze at the minute the card was drawn: the terminal passed
 * `now={Date.now()}` and only re-rendered when something else changed. The
 * card keeps its own minute clock, so only that card repaints as time passes,
 * not the whole terminal.
 */
const CARD = await Bun.file(new URL("../src/terminal/GateCard.tsx", import.meta.url)).text();
const TERMINAL = await Bun.file(new URL("../app/(tabs)/terminal.tsx", import.meta.url)).text();

describe("the waited clock", () => {
  test("lives in the card and ticks once a minute", () => {
    expect(CARD).toContain("const now = useMinute();");
    expect(CARD).toContain("setInterval(() => setNow(Date.now()), 60_000)");
  });

  test("is not handed down by the terminal", () => {
    const tags = TERMINAL.match(/<GateCard[\s\S]*?\/>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).not.toContain("now=");
  });
});
