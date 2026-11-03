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
  exitCode, groupMenu, kindOf, KINDS, menuItems, needsYou, READ_ONLY_REASON, rowAction, startFailure,
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

  /* Docker reports a stop of ours as "Exited (143)" (its SIGTERM) or "(137)"
     (the SIGKILL it sends when the grace period runs out), which is the same
     sentence a crash of the container's own leaves behind. What separates them
     is that this server asked for it, and said so on the row. */
  describe("an exit we asked for", () => {
    const afterStop = (n: number) => c({ state: "exited", status: `Exited (${n}) a minute ago`, stopAskedAt: Date.now() - 60_000 });

    test("143 after a stop of ours is plainly stopped", () => {
      expect(kindOf(afterStop(143))).toBe("stop");
      expect(needsYou(afterStop(143))).toBe(false);
    });

    test("137 after a stop of ours is stopped too", () => {
      expect(kindOf(afterStop(137))).toBe("stop");
      expect(needsYou(afterStop(137))).toBe(false);
    });

    test("the same codes unexplained stay a crash", () => {
      expect(kindOf(exited(143))).toBe("crash");
      expect(kindOf(exited(137))).toBe("crash");
      expect(needsYou(exited(143))).toBe(true);
    });

    test("a code that is not a signal is a crash whatever we asked", () => {
      expect(kindOf(c({ state: "exited", status: "Exited (1) a minute ago", stopAskedAt: Date.now() }))).toBe("crash");
      expect(kindOf(c({ state: "exited", status: "Exited (0) a minute ago", stopAskedAt: Date.now() }))).toBe("stop");
    });
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

describe("docker's own account of a start that failed", () => {
  const shim = (inner: string) => `failed to create shim task: OCI runtime create failed: ${inner}`;

  test("a mount source that is not there names the path it could not mount", () => {
    const f = startFailure(shim('error mounting "/home/dev/orbit/file.conf" to rootfs at "/app/file.conf": no such file or directory'))!;
    expect(f.sentence).toBe("Docker could not start it: a file it needs to mount is missing: /home/dev/orbit/file.conf.");
    expect(f.short).toBe("could not start: a mount is missing");
  });

  test("a port already taken names the port", () => {
    const f = startFailure("driver failed programming external connectivity on endpoint api: Bind for 0.0.0.0:8000 failed: port is already allocated")!;
    expect(f.sentence).toBe("Docker could not start it: a port it needs is already taken: 8000.");
    expect(f.short).toBe("could not start: its port is taken");
  });

  test("a command the image does not have names it", () => {
    const f = startFailure('exec: "/app/start.sh": stat /app/start.sh: no such file or directory')!;
    expect(f.sentence).toBe("Docker could not start it: the command it runs is not in the image: /app/start.sh.");
    expect(f.short).toBe("could not start: command not found");
  });

  /* A mount docker was not allowed to read says both; the one a person can act
     on is the permission. */
  test("permission on a path docker needs wins over the mount it was trying", () => {
    const f = startFailure(shim('error mounting "/srv/orbit" to rootfs at "/app": permission denied'))!;
    expect(f.sentence).toBe("Docker could not start it: it was not allowed to read or write a path it needs: /srv/orbit.");
    expect(f.short).toBe("could not start: not allowed to read a path");
  });

  test("anything else keeps docker's own first 120 characters rather than a guess", () => {
    const raw = `something odd happened ${"x".repeat(200)}`;
    const f = startFailure(raw)!;
    expect(f.sentence).toBe(`Docker could not start it: ${raw.slice(0, 120)}`);
    expect(f.sentence).toHaveLength("Docker could not start it: ".length + 120);
    expect(f.short).toBe("could not start");
  });

  test("no error at all is null, so the caller keeps the text it showed before", () => {
    expect(startFailure("")).toBeNull();
    expect(startFailure("   ")).toBeNull();
    expect(startFailure(null)).toBeNull();
    expect(startFailure(undefined)).toBeNull();
  });

  test("a cause with no path still reads as a sentence", () => {
    expect(startFailure(shim("error mounting something: invalid mount config"))!.sentence)
      .toBe("Docker could not start it: a file it needs to mount is missing.");
  });
});
