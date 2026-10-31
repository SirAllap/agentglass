/*
 * The two-second answer: how many containers need you, the three answers under
 * it, the order stacks come in, and the little map of squares.
 */
import { describe, expect, test } from "bun:test";
import type { DockerContainer, DockerStat } from "../../shared/types.ts";
import {
  answerOf, FOLD_FROM, foldedByDefault, needingFirst, stackMap, stackSummary, triage, withAnswer,
} from "../src/lib/dockerTriage.ts";
import { toStacks } from "../src/lib/dockerStacks.ts";

const c = (over: Partial<DockerContainer> & { id: string }): DockerContainer => ({
  name: `orbit-${over.id}-1`, image: "acme/orbit:dev", state: "running", status: "Up 4 hours",
  ports: "", project: "orbit", service: over.id, workingDir: "/home/dev/code/orbit",
  runningFor: "4 hours ago", size: "", ...over,
});
const sick = (id: string) => c({ id, health: "unhealthy" });
const off = (id: string) => c({ id, state: "exited", status: "Exited (0) 1 hour ago" });
const crash = (id: string) => c({ id, state: "exited", status: "Exited (1) 1 hour ago" });

describe("which answer a container belongs to", () => {
  test("need, run or stop, and nothing is in two", () => {
    expect(answerOf(sick("a"))).toBe("need");
    expect(answerOf(crash("a"))).toBe("need");
    expect(answerOf(c({ id: "a" }))).toBe("run");
    expect(answerOf(off("a"))).toBe("stop");
    expect(answerOf(c({ id: "a", state: "paused" }))).toBe("stop");
    expect(answerOf(c({ id: "a", state: "created", status: "Created" }))).toBe("stop");
  });
});

describe("the sentence", () => {
  test("names the count when something needs you", () => {
    const t = triage([sick("a"), c({ id: "b" }), c({ id: "c" }), off("d")]);
    expect(t.lead).toBe("1 of 4 containers needs you.");
    expect(t.rest).toBe("2 running fine, 1 stopped.");
  });

  test("agrees in number", () => {
    expect(triage([sick("a"), crash("b"), c({ id: "c" })]).lead).toBe("2 of 3 containers need you.");
    expect(triage([sick("a")]).lead).toBe("1 of 1 container needs you.");
  });

  test("says so when nothing does, and calls stopped ones deliberate", () => {
    const t = triage([c({ id: "a" }), off("b")]);
    expect(t.lead).toBe("Nothing needs you.");
    expect(t.rest).toBe("1 running fine, 1 stopped on purpose.");
    expect(triage([c({ id: "a" })]).rest).toBe("1 running fine.");
  });
});

describe("the three answers", () => {
  const all = [sick("a"), crash("b"), c({ id: "c" }), c({ id: "d", state: "paused" }), c({ id: "e", state: "created", status: "Created" }), off("f")];

  test("counts add up to the whole", () => {
    const t = triage(all);
    expect(t.need.length + t.run.length + t.stop.length).toBe(all.length);
    expect([t.need.length, t.run.length, t.stop.length]).toEqual([2, 1, 3]);
  });

  test("Need you says why, in the order of how bad", () => {
    expect(triage(all).why).toBe("1 unhealthy, 1 exited with an error");
    expect(triage([c({ id: "x", state: "restarting" }), c({ id: "y", state: "dead" })]).why).toBe("1 restarting over and over, 1 dead");
    expect(triage([c({ id: "x" })]).why).toBe("nothing is wrong");
  });

  test("Stopped splits paused from never started", () => {
    const t = triage(all);
    expect(t.paused).toBe(1);
    expect(t.made).toBe(1);
  });

  test("names the first three that need you, by worktree when there is one", () => {
    const t = triage([
      c({ id: "a", health: "unhealthy", service: "api", owner: { worktree: "billing-fix", branch: "fix/x", foreign: false, path: "/p" } }),
      c({ id: "b", health: "unhealthy", service: "web" }),
      sick("c"), sick("d"),
    ]);
    expect(t.needNames).toHaveLength(3);
    expect(t.needNames[0]).toBe("billing-fix · api");
    expect(t.needNames[1]).toBe("orbit · web");
  });

  const stat = (id: string, cpu: number, memUsage: string): DockerStat => ({ id, cpu, mem: 1, memUsage, netIO: "", blockIO: "", pids: 1 });

  test("the busiest running container and the memory it all adds up to need stats", () => {
    const t = triage([c({ id: "a" }), c({ id: "b" })], [stat("a", 12.4, "860MiB / 1GiB"), stat("b", 71.4, "1.5GiB / 4GiB")]);
    expect(t.busiest?.name).toBe("orbit-b-1");
    expect(t.busiestCpu).toBe(71.4);
    expect(t.memory).toBe("2.3 GiB");
  });

  test("with no stats there is no busiest and no memory, rather than a zero", () => {
    const t = triage([c({ id: "a" })]);
    expect(t.busiest).toBeNull();
    expect(t.memory).toBeNull();
  });

  test("counts web ports that are open on running containers only", () => {
    const web = { host: 3100, hostEnd: 3100, hostIp: null, container: 3000, containerEnd: 3000, proto: "tcp" as const, web: true };
    const t = triage([c({ id: "a", portList: [web, { ...web, host: 3101 }] }), c({ id: "b", state: "paused", portList: [web] })]);
    expect(t.webPorts).toBe(2);
  });
});

describe("the filter an answer card applies", () => {
  const all = [sick("a"), c({ id: "b" }), off("c")];
  test("keeps only that answer", () => {
    expect(withAnswer(all, "need").map((x) => x.id)).toEqual(["a"]);
    expect(withAnswer(all, "run").map((x) => x.id)).toEqual(["b"]);
    expect(withAnswer(all, "stop").map((x) => x.id)).toEqual(["c"]);
  });
  test("no answer keeps everything", () => {
    expect(withAnswer(all, null)).toHaveLength(3);
  });
});

describe("stack order", () => {
  const mk = (project: string, ...cs: DockerContainer[]) => cs.map((x) => ({ ...x, project }));

  test("stacks with something that needs you come first, the rest keep their order", () => {
    const stacks = toStacks([
      ...mk("alpha", c({ id: "a1" })),
      ...mk("beta", off("b1")),
      ...mk("gamma", crash("g1")),
    ]);
    // toStacks alone ranks a crashed (exited) stack as merely "off": beta, gamma, alpha.
    expect(needingFirst(stacks).map((s) => s.project)).toEqual(["gamma", "beta", "alpha"]);
  });

  test("standalone containers stay last unless they need you", () => {
    const stacks = toStacks([...mk("alpha", c({ id: "a1" })), c({ id: "s1", project: null, health: "unhealthy" })]);
    expect(needingFirst(stacks).map((s) => s.project)).toEqual(["(standalone)", "alpha"]);
  });
});

describe("which stacks start folded", () => {
  const stack = (...cs: DockerContainer[]) => toStacks(cs)[0]!;
  const many = (n: number) => Array.from({ length: n }, (_, i) => c({ id: `m${i}` }));

  test("a small fleet starts open", () => {
    expect(foldedByDefault(stack(c({ id: "a" })), { total: 5 })).toBe(false);
  });

  test("a big fleet folds the stacks that are fine, never one that needs you", () => {
    expect(foldedByDefault(stack(c({ id: "a" })), { total: FOLD_FROM })).toBe(true);
    expect(foldedByDefault(stack(c({ id: "a" }), sick("b")), { total: FOLD_FROM })).toBe(false);
    expect(foldedByDefault(stack(...many(3)), { total: FOLD_FROM - 1 })).toBe(false);
  });

  test("a remembered choice beats the default, and a search or an answer opens everything", () => {
    expect(foldedByDefault(stack(c({ id: "a" })), { total: 70, remembered: false })).toBe(false);
    expect(foldedByDefault(stack(c({ id: "a" })), { total: 5, remembered: true })).toBe(true);
    expect(foldedByDefault(stack(c({ id: "a" })), { total: 70, filtering: true, remembered: true })).toBe(false);
  });

  test("remembering that a stack is open does not hide a stack that now needs you", () => {
    expect(foldedByDefault(stack(sick("a")), { total: 70, remembered: true })).toBe(false);
  });
});

describe("the stack summary", () => {
  test("up of total, and who needs you", () => {
    expect(stackSummary([c({ id: "a" }), c({ id: "b" }), off("c")]).text).toBe("2/3 up");
    expect(stackSummary([c({ id: "a" }), sick("b")]).text).toBe("2/2 up · 1 needs you");
    expect(stackSummary([crash("a"), crash("b")]).text).toBe("0/2 up · 2 need you");
  });
  test("only running counts as up", () => {
    expect(stackSummary([c({ id: "a", state: "restarting" }), c({ id: "b", state: "paused" })]).up).toBe(0);
  });
});

describe("the map of squares", () => {
  const fleet = [c({ id: "a" }), sick("b"), off("c"), c({ id: "d", health: "healthy" })];

  test("one square per container, the ones that need you first", () => {
    const m = stackMap(fleet);
    expect(m).toHaveLength(4);
    expect(m[0]!.id).toBe("b");
    expect(m[0]!.tone).toBe("need");
  });

  test("tones follow the kind", () => {
    const tones = Object.fromEntries(stackMap([
      c({ id: "r", state: "restarting" }), c({ id: "p", state: "paused" }), c({ id: "m", state: "created", status: "Created" }),
      off("s"), c({ id: "u" }), c({ id: "h", health: "healthy" }), crash("x"), c({ id: "z", state: "dead" }),
    ]).map((q) => [q.id, q.tone]));
    expect(tones).toEqual({ r: "restart", p: "pause", m: "made", s: "stop", u: "up", h: "up", x: "need", z: "need" });
  });

  test("squares outside the filter are dim, and the current one is marked", () => {
    const m = stackMap(fleet, { inFilter: new Set(["a", "b"]), selected: "b" });
    expect(m.find((q) => q.id === "a")!.dim).toBe(false);
    expect(m.find((q) => q.id === "c")!.dim).toBe(true);
    expect(m.find((q) => q.id === "b")!.current).toBe(true);
    expect(m.find((q) => q.id === "a")!.current).toBe(false);
  });

  test("with no filter nothing is dim", () => {
    expect(stackMap(fleet).every((q) => !q.dim)).toBe(true);
  });

  test("each square can say what it is, for the screen reader", () => {
    expect(stackMap([sick("b")])[0]!.title).toBe("b: unhealthy");
  });
});
