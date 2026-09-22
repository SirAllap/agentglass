/*
 * Starting an agent in a pane, for a terminal with no tmux.
 *
 * Two things are pinned here and they fail in opposite directions.
 *
 * The TICKET is about not doing something twice: it stands in for a prompt too
 * big to put in a URL, and a ticket that could be claimed twice would start two
 * agents in one worktree from one press — two processes editing the same files,
 * which is the kind of thing you notice an hour later.
 *
 * The ARGV is about the two paths staying one path. A tmux window and a plain
 * pane now run the same agent, and they run it by calling this. If they ever
 * build their own, the flags drift and the difference shows up as "it behaves
 * differently on my machine".
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mintAgentTicket, claimAgentTicket, agentArgv, agentBinFor, __clearAgentTickets } from "../src/agentticket.ts";
import { claudeCode } from "../src/agents/claudecode.ts";

afterEach(() => { __clearAgentTickets(); });

const req = (over = {}) => ({ cwd: "/w/tree", prompt: "fix the spinner", yolo: false, title: "", ...over });

describe("the ticket", () => {
  it("comes back with what was put in", () => {
    const id = mintAgentTicket(req());
    expect(claimAgentTicket(id)).toEqual(req());
  });

  it("can only be claimed once", () => {
    // One press must not become two agents in the same worktree.
    const id = mintAgentTicket(req());
    expect(claimAgentTicket(id)).not.toBeNull();
    expect(claimAgentTicket(id)).toBeNull();
  });

  it("expires", () => {
    const id = mintAgentTicket(req(), 0);
    expect(claimAgentTicket(id, 61_000)).toBeNull();
  });

  it("is still good just inside its minute", () => {
    const id = mintAgentTicket(req(), 0);
    expect(claimAgentTicket(id, 59_000)).not.toBeNull();
  });

  it("says nothing about an id it never issued", () => {
    expect(claimAgentTicket("nope")).toBeNull();
    expect(claimAgentTicket("")).toBeNull();
  });

  it("gives out ids that are not each other", () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintAgentTicket(req())));
    expect(ids.size).toBe(50);
  });

  it("does not grow without bound", () => {
    // A bug upstream must not turn this into a store. The oldest goes; the
    // newest — the press somebody is waiting on — stays.
    for (let i = 0; i < 100; i++) mintAgentTicket(req({ prompt: `p${i}` }));
    const last = mintAgentTicket(req({ prompt: "the one just pressed" }));
    expect(claimAgentTicket(last)?.prompt).toBe("the one just pressed");
  });
});

describe("the command line an agent request becomes", () => {
  it("puts the prompt last, as one argument", () => {
    // A review brief has quotes, newlines and backticks in it. Every one of
    // them is text, never a shell's business.
    const p = "a `weird` prompt\nwith 'quotes' and \"more\"";
    expect(agentArgv("/bin/claude", { prompt: p, yolo: false, title: "" }, false))
      .toEqual(["/bin/claude", p]);
  });

  it("buys exactly one flag with yolo, and only when asked", () => {
    /* No prompt means START IT, and not "run me with an empty argument".
       Measured from the bench: an empty positional was read as the thing to do,
       the CLI exited, and the tmux session holding the tab went with it. */
    expect(agentArgv("/bin/claude", { prompt: "", yolo: false, title: "" }, false))
      .toEqual(["/bin/claude"]);
    expect(agentArgv("/bin/claude", { prompt: "", yolo: true, title: "review" }, true))
      .toEqual(["/bin/claude", "--name", "review", "--dangerously-skip-permissions"]);
    expect(agentArgv("/bin/claude", { prompt: "go", yolo: true, title: "" }, false))
      .toEqual(["/bin/claude", "--dangerously-skip-permissions", "go"]);
    expect(agentArgv("/bin/claude", { prompt: "go", yolo: false, title: "" }, false))
      .toEqual(["/bin/claude", "go"]);
  });

  it("names the session when the binary understands it", () => {
    expect(agentArgv("/bin/claude", { prompt: "go", yolo: false, title: "ORBIT-1042" }, true))
      .toEqual(["/bin/claude", "--name", "ORBIT-1042", "go"]);
  });

  it("leaves the name off a binary that does not take one", () => {
    // An older CLI would refuse to start at all rather than ignore it.
    expect(agentArgv("/bin/claude", { prompt: "go", yolo: false, title: "ORBIT-1042" }, false))
      .toEqual(["/bin/claude", "go"]);
  });

  it("leaves the name off when there is no title", () => {
    expect(agentArgv("/bin/claude", { prompt: "go", yolo: false, title: "" }, true))
      .toEqual(["/bin/claude", "go"]);
  });

  it("orders the flags the way the tmux path always has", () => {
    // Both callers share this now; the order is the one that already shipped.
    expect(agentArgv("/bin/claude", { prompt: "go", yolo: true, title: "T" }, true))
      .toEqual(["/bin/claude", "--name", "T", "--dangerously-skip-permissions", "go"]);
  });

  it("is empty with no agent binary, which callers read as “open a shell”", () => {
    // No agent available is not a reason to open nothing: a shell in the right
    // worktree is still most of what was asked for.
    expect(agentArgv(null, { prompt: "go", yolo: false, title: "" }, true)).toEqual([]);
    expect(agentArgv("", { prompt: "go", yolo: false, title: "" }, true)).toEqual([]);
  });
});

describe("a kind no route accepted", () => {
  it("opens a plain shell rather than Claude's flags on some other binary", () => {
    /* Every route checks the kind against shared/agentKinds.ts before a ticket
       is minted, so this is not reachable from the wire. It used to fall back
       to Claude's row, which on anything but `claude` is an unknown option and
       an immediate exit — the wrong answer for the day a caller forgets. */
    expect(agentArgv("/usr/bin/vim", { prompt: "go", yolo: true, title: "ORBIT-1042", kind: "vim" }, true))
      .toEqual([]);
  });
});

describe("the executable for a kind", () => {
  it("is Claude's own resolver's answer for Claude, so no caller needs to ask it separately", () => {
    // Three call sites branched to claudeCode.bin() for Claude and to this
    // function for the rest. Both are Bun.which("claude"); the branch bought
    // nothing, and it is gone.
    expect(agentBinFor("claude")).toBe(claudeCode.bin());
  });
});
