/*
 * "It mixes up containers from different projects."
 *
 * The server had the right rule all along, in docker.ts, and no way to share
 * it. So the phone grew three approximations out of directory basenames —
 * `repoName` in MobileApp, `baseName` in MobileChats, `projectName` in
 * nowQueue — and compared them to a compose project name with `===`.
 *
 * That comparison cannot work, for two reasons that pull in opposite
 * directions:
 *
 *   - compose lowercases the project name and drops everything outside
 *     [a-z0-9_-], so a checkout at ~/code/My.App runs as project "myapp" and NO
 *     raw basename will ever equal it; and
 *   - two unrelated repositories both called "web" DO compare equal, so each
 *     claims the other's containers.
 *
 * One rule now, in shared/projectKey.ts, imported by both surfaces. The last
 * describe is the one that keeps it that way.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { baseName, normaliseProject, projectKey, inProject, ownerOf } from "../../shared/projectKey.ts";

const SRC = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
/** The rule is about code; a comment quoting the old formula is not a breach. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ctr = (project: string | null, workingDir: string | null = null) => ({ project, workingDir });

describe("naming a project", () => {
  test("the last segment, on either separator", () => {
    expect(baseName("/home/x/code/agentglass")).toBe("agentglass");
    expect(baseName("/home/x/code/agentglass/")).toBe("agentglass");
    expect(baseName("C:\\code\\agentglass")).toBe("agentglass");
  });

  test("compose's own transformation", () => {
    // The case a basename comparison can never match.
    expect(normaliseProject("My.App")).toBe("myapp");
    expect(normaliseProject("orbit-WEB-1042")).toBe("orbit-web-1042");
    expect(normaliseProject("a_b-c")).toBe("a_b-c");
  });

  test("a key carries both", () => {
    expect(projectKey("/home/x/code/My.App/")).toEqual({ dir: "/home/x/code/My.App", project: "myapp" });
  });
});

describe("whether a container belongs to a checkout", () => {
  const k = projectKey("/home/x/code/myapp");

  test("the directory it was brought up from is authoritative", () => {
    expect(inProject(ctr("something-else", "/home/x/code/myapp"), k)).toBe(true);
    expect(inProject(ctr(null, "/home/x/code/myapp/deploy"), k)).toBe(true);
  });

  test("a sibling directory with a matching prefix is not inside it", () => {
    // `/home/x/code/myapp-old` starts with `/home/x/code/myapp`, and a plain
    // startsWith would file its containers under this project.
    expect(inProject(ctr(null, "/home/x/code/myapp-old"), k)).toBe(false);
  });

  test("the compose name matches after normalisation", () => {
    expect(inProject(ctr("myapp"), projectKey("/home/x/code/My.App"))).toBe(true);
  });

  test("nothing matches a container with neither signal", () => {
    expect(inProject(ctr(null, null), k)).toBe(false);
  });
});

describe("which checkout a container belongs to, out of everything we know", () => {
  const roots = [
    "/home/x/code/agentglass",
    "/home/x/code/agentglass/.claude/worktrees/remote-phone",
    "/home/x/code/tmux-chat",
  ];

  test("the deepest directory wins", () => {
    // A worktree lives inside its repository, so both match by path. Answering
    // with the parent files the container under a checkout it was not started
    // from — which is exactly the worktree half of the mixing bug.
    expect(ownerOf(ctr(null, "/home/x/code/agentglass/.claude/worktrees/remote-phone"), roots))
      .toBe("/home/x/code/agentglass/.claude/worktrees/remote-phone");
  });

  test("a directory match beats a name match", () => {
    // Compose named it after the worktree; it was started from the main
    // checkout. The path is the stronger claim.
    expect(ownerOf(ctr("remote-phone", "/home/x/code/agentglass"), roots))
      .toBe("/home/x/code/agentglass");
  });

  test("the compose name is used when there is no directory label", () => {
    expect(ownerOf(ctr("tmux-chat"), roots)).toBe("/home/x/code/tmux-chat");
  });

  test("a container it cannot place gets null, which is a real answer", () => {
    // The phone had no way to express this, so such a container had no screen
    // at all — the queue offered it a Logs button that raised a toast.
    expect(ownerOf(ctr("pg-scratch"), roots)).toBeNull();
    expect(ownerOf(ctr(null, "/opt/stacks/monitoring"), roots)).toBeNull();
  });

  test("two repositories with the same basename do not claim each other", () => {
    const two = ["/home/x/a/web", "/home/x/b/web"];
    // By name alone they are indistinguishable, and that is the honest answer:
    // the first is returned rather than both, and a directory label — which is
    // what real compose writes — separates them properly.
    expect(ownerOf(ctr(null, "/home/x/b/web"), two)).toBe("/home/x/b/web");
    expect(ownerOf(ctr(null, "/home/x/a/web/svc"), two)).toBe("/home/x/a/web");
  });
});

describe("the phone stops guessing", () => {
  test("no mobile file compares a compose project to a directory name", () => {
    /*
     * The rule over the tree. Every one of these was a line like
     * `(c.project ?? "") === name`, and each was written independently, which
     * is how three of them ended up disagreeing about separators and about
     * what an empty path means.
     */
    const offenders: string[] = [];
    for (const file of walk(join(SRC, "mobile"))) {
      const src = code(readFileSync(file, "utf8"));
      if (/\.project\s*\?\?\s*""\)\s*===/.test(src) || /===\s*\(c\.project/.test(src)) {
        offenders.push(file.replace(SRC, ""));
      }
    }
    expect(offenders, "a container matched by name equality").toEqual([]);
  });

  test("attribution goes through the shared rule", () => {
    const app = code(read("mobile/MobileApp.tsx"));
    expect(app).toContain("ownerOf");
    expect(app).toContain("ownerByContainer");
  });

  test("the three private copies of the naming rule are gone", () => {
    // Each file may still USE baseName; none may define its own.
    const defined: string[] = [];
    for (const file of walk(join(SRC, "mobile"))) {
      const src = code(readFileSync(file, "utf8"));
      if (/(?:const|function)\s+(?:baseName|repoName)\s*[=(]/.test(src)) defined.push(file.replace(SRC, ""));
    }
    expect(defined, "a local copy of the project-naming rule").toEqual([]);
  });

  test("a container that belongs to no project is still reachable", () => {
    const app = code(read("mobile/MobileApp.tsx"));
    // It used to search for a repo by name and toast when it found none, so
    // an unplaceable container had no screen.
    expect(app).toContain("openContainer");
    expect(app).toContain("ContainerScreen");
    expect(app).not.toContain("is not in a repo agentglass knows");
  });
});
