/*
 * The facts a row needs, and where each one is allowed to come from.
 *
 * Health and uptime are read out of the sentence `docker ps` already returns —
 * free. Restart counts, start times, the failing probe's output and the volumes
 * a container holds need `docker inspect`, which is why they arrive on a slower
 * clock and in one batch.
 *
 * What is pinned here is the reading itself. A wrong health state paints a row
 * red for nothing; a missed one leaves a broken container looking fine, which
 * is the failure that costs an afternoon.
 */
import { describe, expect, test } from "bun:test";
import { factsFor, healthOf, isRestarting, parseFacts, uptimeOf } from "../src/dockerfacts.ts";

describe("health, out of the status sentence", () => {
  test("the three ways docker writes it", () => {
    expect(healthOf("Up 4 hours (healthy)")).toBe("healthy");
    expect(healthOf("Up 5 seconds (unhealthy)")).toBe("unhealthy");
    expect(healthOf("Up 2 minutes (health: starting)")).toBe("starting");
  });

  /* No health check is NOT "unhealthy". Most containers declare none, and
     painting them as a warning would make the colour mean nothing. */
  test("no check at all is null, not a warning", () => {
    expect(healthOf("Up 4 hours")).toBe(null);
    expect(healthOf("Exited (0) 2 hours ago")).toBe(null);
    expect(healthOf("")).toBe(null);
    expect(healthOf(null)).toBe(null);
  });
});

describe("the human half of the status", () => {
  test("the health parenthesis comes off, the rest is docker's own words", () => {
    expect(uptimeOf("Up 4 hours (healthy)")).toBe("Up 4 hours");
    expect(uptimeOf("Up 2 minutes (health: starting)")).toBe("Up 2 minutes");
    expect(uptimeOf("Exited (0) 2 hours ago")).toBe("Exited (0) 2 hours ago");
  });

  test("and an exit code in parentheses is not mistaken for health", () => {
    // "(0)" and "(healthy)" are both parentheses; only one of them is a state.
    expect(uptimeOf("Exited (137) 5 minutes ago")).toBe("Exited (137) 5 minutes ago");
  });
});

describe("restarting", () => {
  test("is its own state, and it looks up in a list until you say so", () => {
    expect(isRestarting("restarting")).toBe(true);
    expect(isRestarting("Restarting")).toBe(true);
    expect(isRestarting("running")).toBe(false);
  });
});

describe("reading a batched docker inspect", () => {
  const inspect = JSON.stringify([
    {
      Id: "a1b2c3d4e5f6a7b8",
      RestartCount: 8,
      State: {
        StartedAt: "2026-08-19T09:12:31.114Z",
        Health: { FailingStreak: 3, Log: [{ ExitCode: 0, Output: "ok\n" }, { ExitCode: 1, Output: "pg_isready: no response\nconnection refused\n" }] },
      },
      Mounts: [
        { Type: "volume", Name: "frontend", RW: true, Destination: "/app/frontend/build" },
        { Type: "volume", Name: "pnpm-store", RW: false, Destination: "/store" },
        { Type: "bind", Source: "/home/dev/code/orbit", Destination: "/project" },
      ],
    },
    { Id: "ffffffffffffffff", RestartCount: 0, State: { StartedAt: "0001-01-01T00:00:00Z" } },
  ]);

  test("one entry per container, keyed by the short id the panel uses", () => {
    const map = parseFacts(inspect);
    expect([...map.keys()]).toEqual(["a1b2c3d4e5f6", "ffffffffffff"]);
  });

  test("restarts and start time", () => {
    expect(parseFacts(inspect).get("a1b2c3d4e5f6")).toMatchObject({
      restarts: 8, startedAt: "2026-08-19T09:12:31.114Z", healthFailures: 3,
    });
  });

  /* Docker writes a zero timestamp for a container that has never run. Serving
     it would put "started on 1 January year 1" in the detail. */
  test("a container that never started has no start time", () => {
    expect(parseFacts(inspect).get("ffffffffffff")!.startedAt).toBe(null);
  });

  test("the failing probe's own words, first line only", () => {
    // The line that says WHY. The rest is usually a stack trace that would push
    // the row off the screen.
    expect(parseFacts(inspect).get("a1b2c3d4e5f6")!.healthError).toBe("pg_isready: no response");
  });

  test("a passing probe leaves no error behind", () => {
    const ok = JSON.stringify([{ Id: "abc123abc123", State: { Health: { FailingStreak: 0, Log: [{ ExitCode: 0, Output: "fine" }] } } }]);
    expect(parseFacts(ok).get("abc123abc12")).toBeUndefined();      // short id is 12 chars
    expect(parseFacts(ok).get("abc123abc123")!.healthError).toBe(null);
  });

  test("named volumes only, with their write flag — binds are not volumes", () => {
    expect(parseFacts(inspect).get("a1b2c3d4e5f6")!.volumes).toEqual([
      { name: "frontend", rw: true, destination: "/app/frontend/build" },
      { name: "pnpm-store", rw: false, destination: "/store" },
    ]);
  });

  test("garbage in is an empty map, not a throw", () => {
    // A field docker renames between versions must cost that field, not the panel.
    expect(parseFacts("not json").size).toBe(0);
    expect(parseFacts("[]").size).toBe(0);
    expect(parseFacts(JSON.stringify([{ nope: true }])).size).toBe(0);
  });

  test("a container nobody has inspected yet reads as empty, never as absent", () => {
    // So the UI never has to branch on "have we run the medium lane".
    expect(factsFor(new Map(), "whatever")).toEqual({
      startedAt: null, restarts: 0, healthError: null, healthFailures: 0, volumes: [],
    });
  });
});
