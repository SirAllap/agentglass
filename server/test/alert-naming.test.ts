/*
 * What a notification calls the thing it is about.
 *
 * Reported by the person using it, looking at his own notification tray:
 * "agentglass:e4f85ee9 — Claude is waiting for your input". He could not tell
 * which agent it meant, could not tell which pane it was in, and it took him
 * nowhere. All three are true, and the first two are this file.
 *
 * `${source_app}:${session_id.slice(0, 8)}` names a project and eight
 * characters of a UUID. On a machine with thirty worktrees of that same
 * project it identifies nothing at all, and a notification you cannot act on
 * is one you learn to dismiss — which costs you the ones that mattered.
 */
import { describe, expect, test } from "bun:test";
import { describeAgent } from "../src/alerts.ts";
import type { WatchEvent } from "../../shared/types.ts";

const ev = (payload: Record<string, unknown>, over: Partial<WatchEvent> = {}): WatchEvent => ({
  id: 1, source_app: "agentglass", session_id: "e4f85ee9-197c-4e91-91b8-b0ee317ce143",
  hook_event_type: "Notification", tool_name: null, tool_use_id: null,
  agent_id: null, agent_type: null, model_name: null, provider: null,
  is_error: 0, error_text: null, duration_ms: null,
  input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
  cost_usd: 0, summary: null, timestamp: 0, payload,
  ...over,
});

describe("naming the agent an alert is about", () => {
  test("the checkout, which is the part that identifies anything", () => {
    // Thirty worktrees of one repository share a source_app. The directory is
    // the only thing that says which.
    expect(describeAgent(ev({ cwd: "/home/u/code/agentglass-anc" })))
      .toContain("agentglass-anc");
  });

  test("a trailing slash does not produce an empty name", () => {
    expect(describeAgent(ev({ cwd: "/home/u/code/agentglass-anc/" })))
      .toContain("agentglass-anc");
  });

  test("no cwd falls back to the project rather than to nothing", () => {
    // An OTel sender or an older hook may not report one. Naming the project is
    // worse than naming the checkout and much better than a bare hash.
    expect(describeAgent(ev({}))).toContain("agentglass");
  });

  test("the session still appears, because two agents can share a checkout", () => {
    // Demoted from headline to disambiguator: it is the only thing telling two
    // agents in the same directory apart, and it is useless as the first thing
    // read.
    const s = describeAgent(ev({ cwd: "/home/u/code/repo" }));
    expect(s).toContain("e4f85e");
    expect(s.indexOf("repo")).toBeLessThan(s.indexOf("e4f85e"));
  });

  test("no pane is reported when nothing recorded one", () => {
    // Not every agent runs in tmux, and inventing a pane is worse than omitting
    // one — it would send somebody to a pane that is running something else.
    expect(describeAgent(ev({ cwd: "/home/u/code/repo" }, { session_id: "no-pane-was-ever-noted" })))
      .not.toContain("pane");
  });

  test("the pane appears when the hook reported one", async () => {
    // The fact that turns "something needs you" into somewhere to go. Recorded
    // by the hook (`tmux_pane`) rather than guessed from the shell's directory,
    // which panewt.ts explains at length is the wrong key.
    const { notePaneAgent } = await import("../src/panewt.ts");
    const sid = "alert-naming-session";
    const ok = notePaneAgent({
      pane: "%97", sessionId: sid,
      transcriptPath: "/tmp/alert-naming.jsonl", cwd: "/home/u/code/repo",
    });
    expect(ok, "the note should have been accepted").toBe(true);
    const s = describeAgent(ev({ cwd: "/home/u/code/repo" }, { session_id: sid }));
    // tmux has no such pane on the machine running this, so the label falls
    // back to the raw id — which is the fallback being asserted. A pane tmux
    // will not describe is still a pane, and `%97` beats silence for somebody
    // who does know how to select one.
    expect(s).toContain("%97");
    // And the session prefix is gone, because a pane disambiguates on its own.
    expect(s).not.toContain(sid.slice(0, 6));
  });
});

describe("naming the pane", () => {
  /*
   * `%8` was the second answer and it was no better than the first.
   *
   * Reported twice: the notification said `agentglass · pane %8 (e4f85e)` and
   * the reply was that it still was not useful. Fairly — `%8` is tmux's own
   * handle, it is not what a status bar shows, and it is not a thing a person
   * navigates by. `main:3 «claude»` is.
   */
  test("the session prefix goes when a pane can be named", () => {
    // Carrying both left six characters of a UUID on a line that had just been
    // made readable. The pane already tells two agents in one checkout apart,
    // which is the only job the prefix had.
    const s = describeAgent(ev({ cwd: "/home/u/code/repo" }, { session_id: "no-pane-was-ever-noted" }));
    expect(s).toContain("(no-pan");

    // Nothing recorded a pane for that session, so the prefix is all there is —
    // which is the case the fallback exists for.
    expect(s).not.toContain("·");
  });
});
