/*
 * THE FIELD AS TEXT — what the Lantern's chat opens with.
 *
 * Lantern's own "what's going on" readout, in its order: who needs you first,
 * then every agent, working before idle. Composed on the server so the chat
 * starts from what is true now, and so the client never sends a prompt.
 */
import { describe, expect, test } from "bun:test";
import { fieldReadout } from "../src/lantern.ts";
import type { BoardRow } from "../src/agentboard.ts";

const NOW = 1_700_000_000_000;
const row = (over: Partial<BoardRow> = {}): BoardRow => ({
  name: "orbit-1042", worktree: "/code/orbit-feature", branch: "feat/orbit-1042",
  saidAt: NOW - 60_000, from: "seen", state: "working", paneId: "%4", ...over,
});

describe("fieldReadout", () => {
  test("leads with who needs you, then working, then idle", () => {
    const text = fieldReadout([
      row({ name: "busy" }),
      row({ name: "stopped", paneId: "%9", state: "waiting", needsYou: { kind: "permission", why: "Claude needs your permission to use Bash", since: NOW - 5 * 60_000 } }),
      row({ name: "quiet", state: "idle", paneId: "%5" }),
    ], NOW);
    expect(text.startsWith("1 agent stopped on you:")).toBe(true);
    expect(text.indexOf("stopped")).toBeLessThan(text.indexOf("busy"));
    expect(text.indexOf("busy")).toBeLessThan(text.indexOf("quiet"));
    expect(text).toContain("needs your permission for 5m");
    expect(text).toContain('"Claude needs your permission to use Bash"');
    expect(text).toContain("pane %9");
    expect(text).toContain("orbit-feature @ feat/orbit-1042");
  });

  test("says so when nobody does, and still lists the rest", () => {
    const text = fieldReadout([row(), row({ name: "quiet", state: "idle", paneId: "%5" })], NOW);
    expect(text).toContain("Nobody is stopped on you.");
    expect(text).toContain("Working (1):");
    expect(text).toContain("Idle (1):");
  });

  test("carries what an agent said it is on", () => {
    expect(fieldReadout([row({ doing: "the migration" })], NOW)).toContain("on: the migration");
  });
});

/*
 * A ROW IS NOT A PROCESS.
 *
 * Measured by the orchestrator that lives off this readout, on its first round
 * using it: sixteen of its twenty rows were sessions that had ended one and two
 * days earlier. A status line outlives the agent that wrote it on purpose — a
 * row going quiet is information — but a name with no pane and no word since
 * yesterday is not somebody you can go and talk to, and listing it beside the
 * ones you can is what made a field of twenty read as twenty agents.
 */
describe("names that are not agents any more", () => {
  const NOW = Date.now();
  const row = (over: Partial<BoardRow> = {}): BoardRow => ({
    name: "worker", state: "idle", saidAt: NOW - 60_000, ...over,
  } as BoardRow);

  test("no pane and quiet for hours is collapsed onto one line, not listed as an agent", () => {
    const text = fieldReadout([
      row({ name: "alive", paneId: "%4", state: "working" }),
      row({ name: "yesterday", saidAt: NOW - 30 * 60 * 60_000 }),
      row({ name: "day-before", saidAt: NOW - 50 * 60 * 60_000 }),
    ], NOW);
    expect(text).toContain("Gone (2)");
    expect(text).toContain("yesterday, day-before");
    /* One line for the two of them, not one line each. */
    expect(text.split("\n").filter((l) => l.includes("yesterday"))).toHaveLength(1);
    expect(text).toContain("Working (1)");
    expect(text).toContain("Idle (0)");
  });

  test("quiet but reachable is still an agent: a pane is somewhere to go", () => {
    const text = fieldReadout([row({ name: "napping", paneId: "%9", saidAt: NOW - 40 * 60 * 60_000 })], NOW);
    expect(text).toContain("Idle (1)");
    expect(text).not.toContain("Gone");
  });

  test("no pane but spoke recently is still an agent: it may be on another tmux server", () => {
    /* Absence of a pane here is not absence of an agent — the board's own rule,
       and the one that once deleted a live one. */
    const text = fieldReadout([row({ name: "elsewhere", saidAt: NOW - 5 * 60_000 })], NOW);
    expect(text).toContain("Idle (1)");
    expect(text).not.toContain("Gone");
  });

  test("and somebody stopped on a person is never collapsed, however old", () => {
    const text = fieldReadout([row({
      name: "waiting", saidAt: NOW - 40 * 60 * 60_000,
      needsYou: { kind: "input", why: "waiting for your input", since: NOW - 40 * 60 * 60_000 },
    })], NOW);
    expect(text).toContain("1 agent stopped on you");
    expect(text).not.toContain("Gone");
  });
});
