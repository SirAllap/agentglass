/*
 * The understudy must not be offered its own sessions to learn from.
 *
 * Every run cuts a worktree, and every session inside it leaves a transcript
 * project of its own — so each finished task added another "Transcripts — …"
 * row to the Teach list, ticked box and all, waiting to be read in. He spotted
 * it: "nothing new that the clone sees or does should show up as a lesson
 * it has to learn".
 *
 * The reason is stronger than the tidiness. The bank exists to answer how HE
 * decides; filled with the understudy's own transcripts it answers how the
 * understudy decides, which is a copy of a copy. Left alone it compounds: the
 * more it works, the more of the material is its own.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/understudy-sources.ts", import.meta.url)).text();

describe("not its own teacher", () => {
  test("transcript projects belonging to its runs are skipped", () => {
    expect(src).toContain("workRuns(");
    expect(src).toContain("if (mine.has(dir)) continue;");
  });

  test("recognised from the runs table, not from the shape of a name", () => {
    /*
     * A pattern like /understudy-/ would also hide a real project somebody
     * happened to name that way. The worktree path of every run is recorded,
     * and a transcript project directory is that path with its separators
     * flattened — so this is a lookup with an exact answer.
     */
    expect(src).toContain('r.worktree');
    expect(src).not.toMatch(/mine\s*=\s*\/.*understudy/);
  });

  test("the flattening matches how a transcript directory is actually named", () => {
    // Measured against the real pair rather than assumed:
    //   worktree   /home/x/code/agentglass-understudy-a-task-f02598
    //   transcript -home-x-code-agentglass-understudy-a-task-f02598
    const worktree = "/home/x/code/agentglass-understudy-a-task-f02598";
    expect(worktree.replace(/[/.]/g, "-")).toBe("-home-x-code-agentglass-understudy-a-task-f02598");
  });
});
