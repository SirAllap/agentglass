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
 * One rule now, in shared/projectKey.ts, imported by every surface.
 *
 * A fourth describe used to walk `web/src/mobile/` and fail on any file that
 * still compared a compose name to a directory basename, or defined its own
 * copy of the naming rule. That tree is deleted — the browser companion went
 * when the native app replaced it — so the rule-over-the-tree went with it.
 * What is tested here is the rule itself, which is what the server, the cockpit
 * and the phone all now call.
 */
import { describe, expect, test } from "bun:test";
import { baseName, normaliseProject, projectKey, inProject, ownerOf } from "../../shared/projectKey.ts";

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
