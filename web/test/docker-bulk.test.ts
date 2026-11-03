/*
 * Stop all / Start all act on the project in view and on nothing else.
 *
 * The list handed in is the one the Containers view is showing (the project's
 * containers), so the only thing left to decide is which of them a verb can
 * touch: stopping a container that is already stopped is a no-op that reads as
 * a failure, and starting a paused or dead one is a call docker refuses.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DockerContainer } from "../../shared/types.ts";
import { bulkAsk, bulkTargets } from "../src/lib/dockerView.ts";

const c = (id: string, state: string, project = "orbit"): DockerContainer => ({
  id, name: `orbit-${id}`, image: "orbit-app:dev", state,
  status: "", ports: "", project, service: id, workingDir: "/home/dev/code/orbit",
  runningFor: "", size: "",
});

/* 14 containers of the project, 11 of them live: nine running, two restarting.
   Two exited, one created, and one paused — the four that must survive Stop all. */
const project = [
  ...Array.from({ length: 9 }, (_, i) => c(`up${i}`, "running")),
  c("restart-a", "restarting"),
  c("restart-b", "Restarting"),
  c("down-a", "exited"),
  c("down-b", "exited"),
  c("made-a", "created"),
  c("paused-a", "paused"),
];

describe("what Stop all touches", () => {
  test("the 11 live containers and not one of the stopped, made or paused ones", () => {
    const ids = bulkTargets(project, "stop").map((x) => x.id);
    expect(ids).toHaveLength(11);
    expect(ids).toContain("restart-b"); // docker reports "Restarting"
    for (const id of ["down-a", "down-b", "made-a", "paused-a"]) expect(ids).not.toContain(id);
  });

  test("it can only name what the view handed it, so another project is out of reach", () => {
    const ids = bulkTargets(project, "stop");
    expect(ids.every((x) => x.project === "orbit")).toBe(true);
    expect(bulkTargets([], "stop")).toEqual([]);
  });

  test("Start all takes exactly the two states docker start accepts", () => {
    expect(bulkTargets(project, "start").map((x) => x.id)).toEqual(["down-a", "down-b", "made-a"]);
  });

  test("a dead container is neither started nor stopped: it is removed", () => {
    const dead = [c("dead-a", "dead")];
    expect(bulkTargets(dead, "stop")).toEqual([]);
    expect(bulkTargets(dead, "start")).toEqual([]);
  });
});

describe("the list after the verb", () => {
  /* The screen is fed by Docker's events, and the events of eleven stops land
     across the whole loop — one can arrive while the panel's own fetch is on the
     wire. Waiting for the stream alone left every row showing what it showed
     before, which is what the stop-all button did. So the loop is followed by
     one read, and it is a fresh one: the overview cache can hold a sample taken
     halfway through. */
  const panel = readFileSync(new URL("../src/components/DockerPanel.tsx", import.meta.url), "utf8");

  test("Stop all, Start all and the stack's verbs read the list when the loop ends", () => {
    expect(panel).toContain("await group(targets, verb);");
    expect(panel.match(/await reload\(true\)/g)).toHaveLength(2);
  });

  test("nothing here polls: the read is the one the loop triggers", () => {
    expect(panel).not.toMatch(/setInterval\(/);
  });
});

describe("the question it asks", () => {
  test("names the count it is about to stop and says nothing is deleted", () => {
    expect(bulkAsk("stop", 11)).toEqual({
      title: "Stop 11 running containers?",
      body: "Nothing is deleted; Start all brings them back",
      confirmLabel: "Stop all",
    });
  });

  test("one container is not 'containers'", () => {
    expect(bulkAsk("stop", 1).title).toBe("Stop 1 running container?");
    expect(bulkAsk("start", 1).title).toBe("Start 1 stopped container?");
  });

  test("Start all says what it will not do either", () => {
    expect(bulkAsk("start", 3).title).toBe("Start 3 stopped containers?");
    expect(bulkAsk("start", 3).body).toContain("Nothing is created");
  });
});
