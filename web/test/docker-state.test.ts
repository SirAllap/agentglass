/*
 * What one container is, what its row offers, and what its menu holds.
 *
 * The nine kinds are the redesign's vocabulary: colour, shape and a word, so a
 * state is never told by colour alone. "Needs you" is derived from the kind,
 * never from a second rule, so the sentence, the filter and the map cannot
 * disagree about which containers are in trouble.
 */
import { describe, expect, test } from "bun:test";
import type { DockerContainer } from "../../shared/types.ts";
import {
  exitCode, groupMenu, kindOf, KINDS, menuItems, needsYou, READ_ONLY_REASON, rowAction,
} from "../src/lib/dockerState.ts";

const c = (over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: "b72c", name: "orbit-api-1", image: "acme/orbit-api:dev", state: "running", status: "Up 4 hours",
  ports: "", project: "orbit", service: "api", workingDir: "/home/dev/code/orbit",
  runningFor: "4 hours ago", size: "", ...over,
});
const exited = (n: number) => c({ state: "exited", status: `Exited (${n}) 2 hours ago` });

describe("the exit code", () => {
  test("is read out of the status sentence", () => {
    expect(exitCode(exited(137))).toBe(137);
    expect(exitCode(exited(0))).toBe(0);
  });
  test("is unknown, not zero, when the status does not say", () => {
    expect(exitCode(c())).toBeNull();
    expect(exitCode(c({ state: "exited", status: "Exited" }))).toBeNull();
  });
});

describe("the nine kinds", () => {
  test.each([
    [c(), "up"],
    [c({ health: "healthy" }), "healthy"],
    [c({ health: "starting" }), "up"],
    [c({ health: "unhealthy" }), "unhealthy"],
    [c({ state: "restarting" }), "restarting"],
    [c({ state: "paused" }), "paused"],
    [exited(0), "stop"],
    [exited(1), "crash"],
    [c({ state: "created", status: "Created" }), "made"],
    [c({ state: "dead" }), "dead"],
  ] as const)("%#", (ct, kind) => expect(kindOf(ct)).toBe(kind));

  /* Mockup order: dead, then restarting, then unhealthy, then paused. A
     restarting container with a stale unhealthy flag is a restart loop first. */
  test("restarting outranks unhealthy, unhealthy outranks paused", () => {
    expect(kindOf(c({ state: "restarting", health: "unhealthy" }))).toBe("restarting");
    expect(kindOf(c({ state: "paused", health: "unhealthy" }))).toBe("unhealthy");
  });

  test("an exit nobody can read is a plain stop, not a crash", () => {
    expect(kindOf(c({ state: "exited", status: "Exited" }))).toBe("stop");
  });

  test("a state docker invents later reads as stopped rather than as nothing", () => {
    expect(kindOf(c({ state: "removing" }))).toBe("stop");
  });

  test("every kind has a word, a tone and a shape, and no two share the word", () => {
    const words = Object.values(KINDS).map((k) => k.word);
    expect(Object.keys(KINDS)).toHaveLength(9);
    expect(new Set(words).size).toBe(9);
    for (const k of Object.values(KINDS)) {
      expect(k.tone).toMatch(/^var\(--/);
      expect(k.shape.length).toBeGreaterThan(0);
    }
    expect(KINDS.crash.word).toBe("exited with an error");
    expect(KINDS.made.word).toBe("created, never started");
  });

  test("a crash and a stop share a colour family but not a shape", () => {
    expect(KINDS.crash.shape).not.toBe(KINDS.stop.shape);
    expect(KINDS.unhealthy.shape).not.toBe(KINDS.dead.shape);
  });
});

describe("needs you", () => {
  test("unhealthy, restarting, crashed and dead do", () => {
    for (const ct of [c({ health: "unhealthy" }), c({ state: "restarting" }), exited(2), c({ state: "dead" })]) {
      expect(needsYou(ct)).toBe(true);
    }
  });
  test("stopped on purpose, paused, never started and running do not", () => {
    for (const ct of [exited(0), c({ state: "paused" }), c({ state: "created", status: "Created" }), c(), c({ health: "starting" })]) {
      expect(needsYou(ct)).toBe(false);
    }
  });
});

describe("the row's one action", () => {
  test.each([
    ["up", "restart", "Restart"],
    ["healthy", "restart", "Restart"],
    ["unhealthy", "restart", "Restart"],
    ["restarting", "restart", "Restart"],
    ["paused", "unpause", "Resume"],
    ["stop", "start", "Start"],
    ["crash", "start", "Start"],
    ["made", "start", "Start"],
    ["dead", "rm", "Remove"],
  ] as const)("%s offers %s", (kind, verb, label) => {
    const a = rowAction(kind);
    expect(a.verb).toBe(verb);
    expect(a.label).toBe(label);
  });

  test("Resume is green, Remove is red, Restart on a sick container is red", () => {
    expect(rowAction("paused").tone).toBe("var(--success)");
    expect(rowAction("dead").tone).toBe("var(--error)");
    expect(rowAction("unhealthy").tone).toBe("var(--error)");
    expect(rowAction("up").tone).toBe("var(--text2)");
  });
});

describe("the ... menu", () => {
  const verbs = (items: ReturnType<typeof menuItems>) => items.map((i) => i.verb);

  test("a running container: reads first, then Stop and a Remove that waits for the stop", () => {
    const m = menuItems(c({ ports: "0.0.0.0:3100->3000/tcp", portList: [{ host: 3100, hostEnd: 3100, hostIp: null, container: 3000, containerEnd: 3000, proto: "tcp", web: true }] }));
    expect(verbs(m)).toEqual(["logs", "shell", "open", "hr", "stop", "rm"]);
    const rm = m.find((i) => i.verb === "rm")!;
    expect(rm.disabled).toBe(true);
    expect(rm.reason).toBe("Stop it first");
    expect(m.find((i) => i.verb === "open")!.label).toBe("Open in browser · :3100");
  });

  test("no web port, no Open in browser", () => {
    expect(verbs(menuItems(c()))).not.toContain("open");
  });

  test("a stopped container can be removed straight away", () => {
    const rm = menuItems(exited(0)).find((i) => i.verb === "rm")!;
    expect(rm.disabled).toBeFalsy();
    expect(verbs(menuItems(exited(0)))).toEqual(["logs", "hr", "rm"]);
  });

  test("a paused container: Resume lives here too, Stop and Remove stay", () => {
    expect(verbs(menuItems(c({ state: "paused" })))).toEqual(["logs", "hr", "unpause", "stop", "rm"]);
  });

  test("a dead container has no Remove here: it is the row's button", () => {
    expect(verbs(menuItems(c({ state: "dead" })))).toEqual(["logs"]);
  });

  test("the detail menu swaps Logs for Inspect", () => {
    expect(verbs(menuItems(c(), { where: "detail" }))).toContain("insp");
    expect(verbs(menuItems(c(), { where: "detail" }))).not.toContain("logs");
  });

  test("read-only keeps only what reads", () => {
    expect(verbs(menuItems(c(), { readOnly: true }))).toEqual(["logs"]);
    expect(verbs(menuItems(c(), { readOnly: true, where: "detail" }))).toEqual(["insp"]);
  });
});

describe("read-only on the row", () => {
  test("the one action is disabled and says why", () => {
    const a = rowAction("up", { readOnly: true });
    expect(a.disabled).toBe(true);
    expect(a.reason).toBe(READ_ONLY_REASON);
  });
  test("a writable instance disables nothing", () => {
    expect(rowAction("up").disabled).toBeFalsy();
  });
});

describe("the group menu", () => {
  const fleet = [c(), c({ id: "x2", state: "restarting" }), { ...exited(0), id: "x3" }, c({ id: "x4", state: "created", status: "Created" }), c({ id: "x5", state: "paused" })];

  test("counts what each verb would touch", () => {
    const g = groupMenu(fleet);
    expect(g.start.count).toBe(2);
    expect(g.restart.count).toBe(2);
    expect(g.stop.count).toBe(2);
    expect(g.start.label).toBe("Start the 2 stopped");
    expect(g.restart.label).toBe("Restart all running");
    expect(g.stop.label).toBe("Stop all running");
  });

  test("a verb with nothing to touch is disabled", () => {
    const g = groupMenu([c()]);
    expect(g.start.disabled).toBe(true);
    expect(g.restart.disabled).toBeFalsy();
  });

  test("the targets are ids, so the caller cannot act on the wrong set", () => {
    const g = groupMenu(fleet);
    expect(g.start.ids.sort()).toEqual(["x3", "x4"]);
    expect(g.stop.ids).not.toContain("x5");
  });

  test("read-only disables all three with the reason", () => {
    const g = groupMenu(fleet, { readOnly: true });
    for (const v of [g.start, g.restart, g.stop]) {
      expect(v.disabled).toBe(true);
      expect(v.reason).toBe(READ_ONLY_REASON);
    }
  });

  test("the header button is Start all when nothing runs, Restart all otherwise", () => {
    expect(groupMenu([exited(0), exited(1)]).button.label).toBe("Start all");
    expect(groupMenu([exited(0), exited(1)]).button.verb).toBe("start");
    expect(groupMenu(fleet).button.label).toBe("Restart all");
    expect(groupMenu(fleet).button.verb).toBe("restart");
  });

  test("a restart loop counts as running for the button", () => {
    expect(groupMenu([c({ state: "restarting" })]).button.label).toBe("Restart all");
  });
});
