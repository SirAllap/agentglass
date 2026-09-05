/*
 * The small decisions a Docker row makes.
 *
 * Each one is a sentence the panel says out loud about somebody's machine, and
 * two of them are easy to get wrong in the direction that matters: calling a
 * sibling worktree's container yours, and painting a container that declares no
 * health check as if something were wrong with it.
 */
import { describe, expect, test } from "bun:test";
import type { DockerContainer, DockerPort } from "../../shared/types.ts";
import {
  firstReachable, freshnessLabel, freshnessNote, healthLabel, healthTint,
  ownerTint, ownerTitle, portLabel, portUrl,
} from "../src/lib/dockerRow.ts";

const port = (p: Partial<DockerPort>): DockerPort => ({
  host: 8000, hostEnd: 8000, hostIp: "0.0.0.0", container: 8000, containerEnd: 8000, proto: "tcp", web: true, ...p,
});
const container = (c: Partial<DockerContainer>): DockerContainer => ({
  id: "abc123abc123", name: "orbit-app", image: "orbit-django:dev", state: "running",
  status: "Up 4 hours", ports: "", project: "orbit", service: "app",
  workingDir: "/home/dev/code/orbit", runningFor: "4 hours ago", size: "", ...c,
});

describe("which port a row shows", () => {
  test("the one you can open wins over one you cannot", () => {
    const list = [port({ host: 5432, container: 5432, web: false }), port({ host: 8000, web: true })];
    expect(firstReachable(list)!.host).toBe(8000);
  });

  test("failing that, the first published one", () => {
    const list = [port({ host: null, container: 5432, web: false }), port({ host: 5432, container: 5432, web: false })];
    expect(firstReachable(list)!.host).toBe(5432);
  });

  test("and nothing at all when there is nothing", () => {
    expect(firstReachable([])).toBe(null);
    expect(firstReachable(undefined)).toBe(null);
  });

  test("the label is the host port, the url points at localhost", () => {
    expect(portLabel(port({ host: 8000 }))).toBe(":8000");
    expect(portUrl(port({ host: 8000 }))).toBe("http://localhost:8000");
  });

  /* A link that goes nowhere is worse than no link: it teaches people the chip
     lies, and then the ones that work stop being pressed too. */
  test("a port that cannot be opened has no url", () => {
    expect(portUrl(port({ host: 5432, container: 5432, web: false }))).toBe(null);
    expect(portUrl(port({ host: null, web: false }))).toBe(null);
  });
});

describe("health", () => {
  test("no health check declared is not a warning", () => {
    // Most containers are in this state. A colour here would mean "container".
    expect(healthTint(null)).toBe(null);
    expect(healthLabel(container({ health: null }))).toBe(null);
  });

  test("unhealthy is red, and says how many probes have failed", () => {
    expect(healthTint("unhealthy")).toBe("var(--error)");
    expect(healthLabel(container({ health: "unhealthy", healthFailures: 3 }))).toBe("unhealthy · 3");
    expect(healthLabel(container({ health: "unhealthy", healthFailures: 1 }))).toBe("unhealthy");
  });

  test("starting is amber — it is not failing yet", () => {
    expect(healthTint("starting")).toBe("var(--warning)");
    expect(healthLabel(container({ health: "starting" }))).toBe("starting");
  });
});

describe("the owner chip", () => {
  const mine = { worktree: "orbit", branch: "main", foreign: false, path: "/home/dev/code/orbit" };
  const theirs = { worktree: "orbit-1042", branch: "ORBIT-1042-caller-id", foreign: true, path: "/home/dev/code/orbit-1042" };

  /* Amber, not red. A container from another worktree is running exactly as
     intended — it just isn't the checkout you have open. */
  test("somebody else's checkout is amber, yours is quiet", () => {
    expect(ownerTint(theirs)).toBe("var(--warning)");
    expect(ownerTint(mine)).toBe("var(--text3)");
    expect(ownerTint(undefined)).toBe("var(--text3)");
  });

  test("the tooltip carries the branch and the path", () => {
    const t = ownerTitle(theirs);
    expect(t).toContain("orbit-1042 — another worktree");
    expect(t).toContain("branch ORBIT-1042-caller-id");
    expect(t).toContain("/home/dev/code/orbit-1042");
  });

  test("a detached HEAD says so instead of pretending to have a branch", () => {
    expect(ownerTitle({ ...mine, branch: null })).toContain("detached HEAD");
  });

  test("no owner, no tooltip", () => {
    expect(ownerTitle(undefined)).toBe("");
  });
});

describe("how old the picture is", () => {
  const now = 1_787_000_000_000;

  test("seconds while it is seconds, because that is the range that matters", () => {
    expect(freshnessLabel(now - 500, now)).toBe("just now");
    expect(freshnessLabel(now - 12_000, now)).toBe("12s ago");
    expect(freshnessLabel(now - 90_000, now)).toBe("2m ago");
    expect(freshnessLabel(now - 7_200_000, now)).toBe("2h ago");
  });

  test("no timestamp, nothing to say", () => {
    expect(freshnessLabel(undefined, now)).toBe("");
  });

  test("the note names the failure, not the age", () => {
    expect(freshnessNote("retrying")).toContain("retrying");
    expect(freshnessNote("down")).toContain("not answering");
    expect(freshnessNote("live")).toBe(null);
  });

  /* A gather that took a while is worth naming: a daemon that is merely busy
     resolves itself, and a message that says so stops the reflex to reload. */
  test("a slow gather is called slow, a quick one is not mentioned", () => {
    expect(freshnessNote("stale", 4000)).toContain("slow");
    expect(freshnessNote("stale", 40)).toBe(null);
  });
});
