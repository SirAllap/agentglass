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
