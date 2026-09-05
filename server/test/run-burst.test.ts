// Four legs asked for, four legs started.
//
// This is the whole reason `/run/start` does the work on the server instead of
// asking the terminal socket four times. The path a single "send this to an
// agent" press takes is: the panel leaves the request in a one-slot mailbox
// (web/src/lib/termIssue.ts), the terminal view notices, and the socket carries
// it over. That mailbox exists because the panel cannot reach the socket and
// the terminal view may not even be mounted yet, which is a real problem and a
// good answer to it — for ONE request.
//
// A run is a burst, and the mailbox is a single variable that each request
// assigns to. The first half of this file pins what that costs: four requests
// in, one survives, and nothing anywhere reports the other three, because
// overwriting a variable is not an error. It is asserted against the real
// module rather than described in a comment, so the day somebody makes it a
// queue this test says so instead of quietly passing.
//
// The second half is the replacement: one call, one loop, every leg awaited,
// and the count that comes back is the count that was asked for.
import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-run-burst-")));
const ROOT = join(dir, "repo");

process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "burst.db");
process.env.AGENTGLASS_ROOT = dir;

let runs: typeof import("../src/runs.ts");
let mailbox: typeof import("../../web/src/lib/termIssue.ts");

beforeAll(async () => {
  process.env.AGENTGLASS_ROOT = dir;
  runs = await import("../src/runs.ts");
  mailbox = await import("../../web/src/lib/termIssue.ts");
  runs.__clearRuns();
});

afterEach(() => { mailbox.clearTermIssue(); });

describe("the mailbox the run route does not use", () => {
  test("keeps one of four requests, and says nothing about the rest", () => {
    for (const w of ["alpha", "beta", "gamma", "delta"]) {
      mailbox.requestTermIssue(`/w/${w}`, w, "compare two approaches", true);
    }
    const held = mailbox.termIssue()!;
    // It counted four. It is holding one — the last — and the other three
    // directories are simply not anywhere any more.
    expect(held.n).toBe(4);
    expect(held.cwd).toBe("/w/delta");
  });
});

describe("a run started on the server", () => {
  /** Nothing here needs a git repository or a tmux server: what is under test
   *  is that four requests survive the trip, not what git does with them. Each
   *  call is recorded so the assertions can count them. */
  const recorder = () => {
    const cuts: string[] = [];
    const opened: { name: string; cwd: string; argv: string[] }[] = [];
    return {
      cuts,
      opened,
      deps: {
        cut: (_root: string, path: string) => { cuts.push(path); return { ok: true }; },
        open: async (_root: string, name: string, argv: string[], cwd: string) => {
          opened.push({ name, cwd, argv });
          return { paneId: `%${opened.length}`, windowId: `@${opened.length}` };
        },
        bin: (agent: string) => `/usr/bin/${agent}`,
        exists: (p: string) => p === ROOT,
      },
    };
  };

  test("cuts four checkouts and starts four agents", async () => {
    const rec = recorder();
    const r = await runs.startRun(
      ROOT,
      "compare two approaches",
      [{ agent: "claude-code" }, { agent: "codex" }, { agent: "gemini" }, { agent: "claude-code" }],
      rec.deps,
    );
    expect(r.ok).toBe(true);
    expect(rec.cuts).toHaveLength(4);
    expect(rec.opened).toHaveLength(4);
    expect(r.run!.legs).toHaveLength(4);
    // And every one of them is a distinct place, which is the other half of not
    // losing a request: four legs in one directory is four agents editing the
    // same files.
    expect(new Set(rec.cuts).size).toBe(4);
    expect(new Set(r.run!.legs.map((l) => l.paneId)).size).toBe(4);
  });

  test("the same agent twice gets two branches, not one and a collision", async () => {
    const rec = recorder();
    const r = await runs.startRun(
      ROOT,
      "twice",
      [{ agent: "codex" }, { agent: "codex" }],
      rec.deps,
    );
    const branches = r.run!.legs.map((l) => l.branch);
    expect(new Set(branches).size).toBe(2);
    expect(branches[1]).toBe(`${branches[0]}-2`);
  });

  test("every leg is started in its own checkout, with the run's prompt", async () => {
    const rec = recorder();
    const r = await runs.startRun(ROOT, "the one question", [{ agent: "codex" }, { agent: "gemini" }], rec.deps);
    for (const [i, leg] of r.run!.legs.entries()) {
      expect(rec.opened[i]!.cwd).toBe(leg.worktree);
      // Last, and one argument. A prompt is text — quotes, newlines and all —
      // and agentArgv is what keeps it that way for both spawners.
      expect(rec.opened[i]!.argv.at(-1)).toBe("the one question");
    }
  });

  test("one leg that cannot be cut does not take the others with it", async () => {
    const rec = recorder();
    const deps = {
      ...rec.deps,
      cut: (_root: string, path: string) =>
        path.includes("gemini") ? { ok: false, error: "branch already exists" } : (rec.cuts.push(path), { ok: true }),
    };
    const r = await runs.startRun(
      ROOT,
      "partial",
      [{ agent: "claude-code" }, { agent: "gemini" }, { agent: "codex" }],
      deps,
    );
    // Two arms is a comparison. Throwing them away over the third is not a
    // safer answer, it is a worse one.
    expect(r.ok).toBe(true);
    expect(r.run!.legs).toHaveLength(2);
    expect(r.detail).toContain("Started 2 of 3 legs");
    expect(r.detail).toContain("branch already exists");
  });

  test("records the agent it really got, not the one that was asked for", async () => {
    // No binary on this machine for that vendor. The leg still opens — a shell
    // in the right checkout is most of what was asked for — but it must not
    // claim to be a codex arm of a vendor comparison.
    const rec = recorder();
    const r = await runs.startRun(ROOT, "missing binary", [{ agent: "codex" }], { ...rec.deps, bin: () => null });
    expect(r.run!.legs[0]!.agent).toBe("");
    expect(rec.opened[0]!.argv).toEqual([]);
  });

  test("refuses a run with nothing to ask, no legs, or too many", async () => {
    const rec = recorder();
    expect((await runs.startRun(ROOT, "  ", [{ agent: "codex" }], rec.deps)).ok).toBe(false);
    expect((await runs.startRun(ROOT, "q", [], rec.deps)).ok).toBe(false);
    const many = Array.from({ length: 9 }, () => ({ agent: "codex" }));
    const r = await runs.startRun(ROOT, "q", many, rec.deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("capped at 8");
    // Nothing was cut on the way to refusing.
    expect(rec.cuts).toHaveLength(0);
  });

  test("refuses a root outside the open project", async () => {
    const rec = recorder();
    const r = await runs.startRun("/somewhere/else", "q", [{ agent: "codex" }], {
      ...rec.deps,
      exists: () => true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside the open project");
  });
});
