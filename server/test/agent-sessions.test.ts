/*
 * The sessions a project has, wherever they ran.
 *
 * Asked for like this: "que este desplegable me abra directamente la tab o el
 * pane… muéstrame todas las sesiones que haya en todas las rutas del proyecto,
 * ya que puede que hayan sesiones en worktrees que no se muestren".
 *
 * That last clause is the whole feature. `/resume` lists the transcripts of the
 * directory the agent is running in, so a session from a worktree is invisible
 * from the main checkout — and those are the ones being looked for, because a
 * worktree is where the work was. This walks every checkout `git worktree list`
 * reports and reads the same files the CLI reads.
 *
 * Against real files in a real repository: the whole thing is a directory name
 * derived from a path, a `readdir`, and two reads of a JSONL. Mocking any of
 * those would be mocking the feature.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string, wt: string, home: string;
let mod: typeof import("../src/agentsessions.ts");
let slug: (cwd: string) => string;

const run = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** A transcript, in the shape the CLI writes: a summary line, then the turns. */
function transcript(dir: string, id: string, lines: unknown[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "agx-sess-"));
  home = mkdtempSync(join(tmpdir(), "agx-claude-"));
  process.env.AGENTGLASS_ROOT = repo;
  process.env.AGENTGLASS_CLAUDE_HOME = home;
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "t@example.com");
  run(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "first");
  wt = `${repo}-CARD-1`;
  run(repo, "worktree", "add", "-q", "-b", "CARD-1", wt);

  ({ projectSlug: slug } = await import("../src/agents/claudecode.ts"));
  const projects = join(home, "projects");
  // One in the main checkout, one in the worktree — the case the CLI's own list
  // cannot show you from here.
  transcript(join(projects, slug(repo)), "11111111-1111-1111-1111-111111111111", [
    { type: "summary", summary: "Rounding at the cart boundary" },
    user("why is the total a cent low"),
    assistant("because the discount rounds twice"),
  ]);
  transcript(join(projects, slug(wt)), "22222222-2222-2222-2222-222222222222", [
    user("/clear"),
    user("port the runbook to the wiki"),
    assistant("moved the last three sections"),
  ]);
  mod = await import("../src/agentsessions.ts");
});

afterAll(() => {
  for (const d of [wt, repo, home]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } }
});

describe("sessions for a project", () => {
  it("finds the ones that ran in a worktree, not only the main checkout", async () => {
    const rows = await mod.sessionsForProject(repo);
    expect(rows.map((r) => r.cwd).sort()).toEqual([repo, wt].sort());
  });

  it("names each one the way /resume does — the CLI's summary when there is one", async () => {
    const rows = await mod.sessionsForProject(repo);
    const main = rows.find((r) => r.cwd === repo)!;
    expect(main.title).toBe("Rounding at the cart boundary");
    // And the opening still shows, because a four-word summary is not enough to
    // tell two mornings apart — which is why the cards carry both.
    expect(main.opening).toBe("why is the total a cent low");
  });

  it("falls back to the first real user message, skipping the plumbing", async () => {
    /* A slash command is not what the session was about. Titling forty sessions
       "/clear" is the failure this avoids. */
    const rows = await mod.sessionsForProject(repo);
    const card = rows.find((r) => r.cwd === wt)!;
    expect(card.title).toBe("port the runbook to the wiki");
  });

  it("says where each one got to, which is what 'which one was I on' asks", async () => {
    const rows = await mod.sessionsForProject(repo);
    expect(rows.find((r) => r.cwd === wt)!.last).toBe("moved the last three sections");
  });

  it("uses the name somebody gave it, over any guess", async () => {
    /*
     * `/rename` APPENDS `{"type":"custom-title",…}` — it does not rewrite the
     * head — so a name has to be read from the tail, and the last one wins.
     * Measured on a real 5.8MB transcript: the first title line sat at 18% of
     * the file and the last at the very end, which is why a head-only read
     * showed the first user message under a session the CLI lists by name.
     */
    const projects = join(home, "projects");
    transcript(join(projects, slug(repo)), "33333333-3333-3333-3333-333333333333", [
      { type: "summary", summary: "a guess nobody chose" },
      user("start on the exit survey"),
      assistant("done"),
      { type: "custom-title", customTitle: "first name", sessionId: "33333333" },
      { type: "custom-title", customTitle: "handover", sessionId: "33333333" },
    ]);
    const rows = await mod.sessionsForProject(repo);
    expect(rows.find((r) => r.id.startsWith("33333333"))!.title).toBe("handover");
  });

  it("hands back an id `--resume` can take", async () => {
    const rows = await mod.sessionsForProject(repo);
    expect(rows.every((r) => /^[0-9a-f-]{36}$/.test(r.id))).toBe(true);
  });

  it("refuses a path outside the workspace rather than listing it", async () => {
    // What comes back becomes a `-c` and a command line.
    expect(await mod.sessionsForProject("/etc")).toEqual([]);
  });
});
