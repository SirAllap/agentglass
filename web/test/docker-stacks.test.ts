/*
 * A compose project as a thing you can read in one line.
 *
 * The opinions pinned here are the ones that decide whether the panel is useful
 * at a glance: what counts as broken (a container docker is restarting in a
 * loop looks "up" in every flat list), what a stopped stack looks like (normal,
 * not red), and which stack goes first (the broken one, always).
 */
import { describe, expect, test } from "bun:test";
import type { DockerContainer } from "../../shared/types.ts";
import { containerHealth, filterStacks, initiallyOpen, LOOSE, matchesQuery, NO_OWNER, stackDots, stackLabel, toStacks, toWorktrees, worstOf } from "../src/lib/dockerStacks.ts";

const c = (over: Partial<DockerContainer> & { name: string }): DockerContainer => ({
  id: over.name, image: "orbit-django:dev", state: "running", status: "Up 4 hours",
  ports: "", project: "orbit", service: over.name, workingDir: "/home/dev/code/orbit",
  runningFor: "4 hours ago", size: "", ...over,
});

describe("what one container reads as", () => {
  test("running and healthy is fine", () => {
    expect(containerHealth(c({ name: "app" }))).toBe("ok");
    expect(containerHealth(c({ name: "app", health: "healthy" }))).toBe("ok");
  });

  /* The one this exists for: docker restarting something in a loop is "up" in
     `docker ps` and in every flat list built from it. */
  test("restarting is a warning, not a green light", () => {
    expect(containerHealth(c({ name: "agent", state: "restarting" }))).toBe("warn");
  });

  test("unhealthy is broken even while it runs", () => {
    expect(containerHealth(c({ name: "db", state: "running", health: "unhealthy" }))).toBe("bad");
  });

  test("a health check still starting is a warning", () => {
    expect(containerHealth(c({ name: "db", health: "starting" }))).toBe("warn");
  });

  /* A stopped stack is a normal thing to have. Painting it red would make red
     mean "container" instead of "look at this". */
  test("stopped is not broken", () => {
    expect(containerHealth(c({ name: "app", state: "exited" }))).toBe("off");
    expect(containerHealth(c({ name: "app", state: "created" }))).toBe("off");
    expect(containerHealth(c({ name: "app", state: "paused" }))).toBe("off");
  });

  test("dead and removing are", () => {
    expect(containerHealth(c({ name: "app", state: "dead" }))).toBe("bad");
    expect(containerHealth(c({ name: "app", state: "removing" }))).toBe("bad");
  });

  test("the worst of a set is what the stack shows", () => {
    expect(worstOf(["ok", "off", "warn"])).toBe("warn");
    expect(worstOf(["ok", "bad", "warn"])).toBe("bad");
    expect(worstOf(["ok", "ok"])).toBe("ok");
    expect(worstOf([])).toBe("ok");
  });
});

describe("grouping", () => {
  const list = [
    c({ name: "app" }),
    c({ name: "db", health: "unhealthy" }),
    c({ name: "tool", project: null }),
    c({ name: "web", project: "acme-tools", state: "exited" }),
  ];

  test("by compose project, with the loose ones in their own bucket", () => {
    const s = toStacks(list);
    expect(s.map((x) => x.project)).toEqual(["orbit", "acme-tools", LOOSE]);
  });

  test("counts and worst state per stack", () => {
    const orbit = toStacks(list).find((s) => s.project === "orbit")!;
    expect(orbit).toMatchObject({ up: 2, total: 2, worst: "bad" });
  });

  /* Broken first. A stack you have to scroll to find is a stack you will not
     look at, and that is precisely the one that should not need finding. */
  test("the broken stack sorts above the healthy one", () => {
    const s = toStacks([c({ name: "ok1", project: "aaa" }), c({ name: "bad1", project: "zzz", state: "dead" })]);
    expect(s.map((x) => x.project)).toEqual(["zzz", "aaa"]);
  });

  test("standalone goes last whatever state it is in", () => {
    const s = toStacks([c({ name: "loose", project: null, state: "dead" }), c({ name: "app", project: "orbit" })]);
    expect(s.map((x) => x.project)).toEqual(["orbit", LOOSE]);
  });

  test("the stack's owner is the one every container agrees on", () => {
    const own = { worktree: "orbit-1042", branch: "b", foreign: true, path: "/home/dev/code/orbit-1042" };
    const agreed = toStacks([c({ name: "app", owner: own }), c({ name: "db", owner: own })])[0]!;
    expect(agreed.owner?.worktree).toBe("orbit-1042");
    expect(agreed.foreign).toBe(true);
  });

  /* Half a stack started from another checkout is a state nothing else in the
     app reports, and claiming one owner for it would hide exactly that. */
  test("and null when they disagree", () => {
    const a = { worktree: "orbit", branch: null, foreign: false, path: "/home/dev/code/orbit" };
    const b = { worktree: "orbit-1042", branch: null, foreign: true, path: "/home/dev/code/orbit-1042" };
    expect(toStacks([c({ name: "app", owner: a }), c({ name: "db", owner: b })])[0]!.owner).toBe(null);
  });
});

describe("what the row says", () => {
  const stack = (cs: DockerContainer[]) => toStacks(cs)[0]!;

  test("all up is a count", () => {
    expect(stackLabel(stack([c({ name: "a" }), c({ name: "b" })]))).toBe("2 up");
  });

  /* "11/12 up" is a fact; "1 down" is the fact you needed. */
  test("something broken names the problem instead of the ratio", () => {
    expect(stackLabel(stack([c({ name: "a" }), c({ name: "b", state: "dead" })]))).toBe("1 down");
  });

  test("partly running says the ratio", () => {
    expect(stackLabel(stack([c({ name: "a" }), c({ name: "b", state: "exited" })]))).toBe("1/2 up");
  });

  test("nothing running is stopped, not 0/3", () => {
    expect(stackLabel(stack([c({ name: "a", state: "exited" }), c({ name: "b", state: "exited" })]))).toBe("stopped");
  });
});

describe("the dots", () => {
  test("one per container, in order", () => {
    const s = toStacks([c({ name: "a" }), c({ name: "b", state: "dead" }), c({ name: "c", state: "exited" })])[0]!;
    expect(stackDots(s).dots).toEqual(["ok", "bad", "off"]);
    expect(stackDots(s).more).toBe(0);
  });

  test("capped, and the remainder is counted rather than drawn", () => {
    const many = Array.from({ length: 20 }, (_, i) => c({ name: `c${i}` }));
    const s = toStacks(many)[0]!;
    expect(stackDots(s, 14).dots).toHaveLength(14);
    expect(stackDots(s, 14).more).toBe(6);
  });
});

describe("which stacks start open", () => {
  const broken = toStacks([c({ name: "a", project: "orbit", state: "dead" }), c({ name: "b", project: "acme" })]);

  /* The reason to collapse a stack is that it is fine and you want the room.
     A stack with a dead container in it is never that — not even if you
     collapsed it yesterday. */
  test("anything broken opens itself, whatever was remembered", () => {
    expect(initiallyOpen(broken, { orbit: false })["orbit"]).toBe(true);
  });

  test("a healthy stack respects what you chose", () => {
    expect(initiallyOpen(broken, { acme: false })["acme"]).toBe(false);
    expect(initiallyOpen(broken, {})["acme"]).toBe(true);
  });
});

describe("pivoted onto worktrees", () => {
  const own = (worktree: string, foreign: boolean) => ({ worktree, branch: null, foreign, path: `/home/dev/code/${worktree}` });

  test("grouped by the checkout each container came from", () => {
    const s = toWorktrees([
      c({ name: "app", owner: own("orbit", false) }),
      c({ name: "db", owner: own("orbit", false) }),
      c({ name: "agent", project: "acme", owner: own("orbit-1042", true) }),
    ]);
    expect(s.map((x) => x.project)).toEqual(["orbit", "orbit-1042"]);
    expect(s[0]!.total).toBe(2);
  });

  /* The checkout you have open is the one you are asking about; it should not
     be alphabetically third. */
  test("yours first, then the others, then the ones with no checkout", () => {
    const s = toWorktrees([
      c({ name: "x", owner: own("zzz-mine", false) }),
      c({ name: "y", owner: own("aaa-theirs", true) }),
      c({ name: "z", owner: undefined }),
    ]);
    expect(s.map((x) => x.project)).toEqual(["zzz-mine", "aaa-theirs", NO_OWNER]);
  });

  test("a container with no owner is bucketed, never dropped", () => {
    // Something is running and nobody knows whose it is — that is worth seeing.
    expect(toWorktrees([c({ name: "loose", owner: undefined })])[0]!.project).toBe(NO_OWNER);
  });
});

describe("the filter box", () => {
  const list = [
    c({ name: "app", service: "app", image: "orbit-django:dev", owner: { worktree: "orbit-1042", branch: "ORBIT-1042-caller-id", foreign: true, path: "/p" },
        portList: [{ host: 8000, hostEnd: 8000, hostIp: "0.0.0.0", container: 8000, containerEnd: 8000, proto: "tcp", web: true }] }),
    c({ name: "keypad", service: "keypad", image: "orbit-pnpm:dev" }),
  ];

  test("matches the name, the image and the state", () => {
    expect(matchesQuery(list[0]!, "app")).toBe(true);
    expect(matchesQuery(list[0]!, "django")).toBe(true);
    expect(matchesQuery(list[1]!, "django")).toBe(false);
  });

  /* "What is on port 8000" is the actual question, and the flat list could
     never answer it. */
  test("and the published port", () => {
    expect(matchesQuery(list[0]!, "8000")).toBe(true);
    expect(matchesQuery(list[1]!, "8000")).toBe(false);
  });

  test("and the worktree and branch, which the row only implies", () => {
    expect(matchesQuery(list[0]!, "orbit-1042")).toBe(true);
    expect(matchesQuery(list[0]!, "caller-id")).toBe(true);
  });

  test("every word has to land somewhere — two facts, not a phrase", () => {
    expect(matchesQuery(list[0]!, "app 8000")).toBe(true);
    expect(matchesQuery(list[0]!, "app 9999")).toBe(false);
  });

  test("an empty filter matches everything", () => {
    expect(matchesQuery(list[1]!, "   ")).toBe(true);
  });

  test("stacks left empty by the filter disappear", () => {
    // A stack header with nothing under it is a row that answers nothing.
    const stacks = toStacks(list);
    expect(filterStacks(stacks, "keypad").flatMap((s) => s.containers).map((x) => x.name)).toEqual(["keypad"]);
    expect(filterStacks(stacks, "nothing-matches-this")).toEqual([]);
  });
});
