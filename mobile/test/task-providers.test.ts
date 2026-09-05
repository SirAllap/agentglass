/*
 * Whether this machine tracks work anywhere, and what the Inbox does about it.
 *
 * The question this app was getting wrong is not "is ClickUp connected". It is
 * the general one — ClickUp is one task provider of several, and a phone that
 * offers a Cards row to somebody who tracks work in Taskwarrior, or in nothing
 * at all, is showing them somebody else's product.
 *
 * Two failures are guarded here and they fail in opposite directions. Showing
 * the row when there is no board costs a tap to learn nothing. HIDING it on an
 * answer that never arrived costs the row itself, and there is no way to get it
 * back from the phone: providers are connected at the computer.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderId, ProviderState, ProviderStatus } from "../../shared/providers.ts";
import { providerTitle, taskProvider, tracksWork } from "../src/model/taskProviders.ts";
import { BAR, taskDestinations, type Destination } from "../src/nav/bar.ts";

const at = (id: ProviderId, state: ProviderState): ProviderStatus => ({ id, state });

describe("tracksWork", () => {
  test("a connected tracker is a yes", () => {
    expect(tracksWork([at("clickup", "connected")])).toBe(true);
    expect(tracksWork([at("taskwarrior", "connected")])).toBe(true);
  });

  test("any one of them is enough", () => {
    // ClickUp is this workspace's tool and not the definition of a task.
    expect(tracksWork([at("clickup", "needs-auth"), at("taskwarrior", "connected")])).toBe(true);
  });

  test("set up and broken still counts", () => {
    /* "ClickUp refused this token" is not "you do not use ClickUp", and the
       row is the only surface that was going to say so. */
    expect(tracksWork([at("clickup", "error")])).toBe(true);
  });

  test("never set up is a no", () => {
    // The two that mean nobody ever did anything.
    expect(tracksWork([at("clickup", "needs-auth"), at("taskwarrior", "missing-tool")])).toBe(false);
  });

  test("review providers do not answer this question", () => {
    // GitHub being signed in says nothing about where work is tracked.
    expect(tracksWork([at("github", "connected"), at("clickup", "needs-auth")])).toBe(false);
  });

  test("no answer is unknown, not no", () => {
    expect(tracksWork(null)).toBe(null);
    expect(tracksWork(undefined)).toBe(null);
  });

  test("an answer naming no tracker at all is unknown", () => {
    /* A server that did not mention a provider has not said it is absent. The
       direction matters: unknown draws the row, and a row nobody needs is
       recoverable by ignoring it. */
    expect(tracksWork([])).toBe(null);
    expect(tracksWork([at("github", "connected")])).toBe(null);
  });
});

describe("taskDestinations", () => {
  const all: Destination[] = [...BAR.filter((d) => d.route !== "index"), { route: "repos", label: "Source control" }];

  test("keeps cards when something is tracked", () => {
    expect(taskDestinations(all, true).map((d) => d.route)).toContain("tasks");
  });

  test("keeps cards while the answer is unknown", () => {
    // The recoverable direction, and the same one the desk takes.
    expect(taskDestinations(all, null).map((d) => d.route)).toContain("tasks");
  });

  test("drops cards when nothing is tracked", () => {
    expect(taskDestinations(all, false).map((d) => d.route)).not.toContain("tasks");
  });

  test("drops cards and nothing else", () => {
    /* There is nothing to promote in its place, and that is not an oversight:
       the five-slot bar that made a removal need a replacement is retired, and
       source control — the destination that would have been promoted — is
       already in this list. */
    const before = all.map((d) => d.route);
    const after = taskDestinations(all, false).map((d) => d.route);
    expect(after).toEqual(before.filter((r) => r !== "tasks"));
  });

  test("the order is never rearranged", () => {
    for (const answer of [true, false, null]) {
      const got = taskDestinations(all, answer).map((d) => d.route);
      expect(got).toEqual(all.map((d) => d.route).filter((r) => got.includes(r)));
    }
  });

  test("BAR itself is untouched — it is the claim, not the drawing", () => {
    // Every other reader of BAR (the Inbox's own list, keyLayout's ordering)
    // still sees the five this app is for.
    taskDestinations(all, false);
    expect(BAR.map((d) => d.route)).toContain("tasks");
    expect(BAR.length).toBe(5);
  });
});

describe("taskProvider — which tracker the Cards tab reads", () => {
  test("ClickUp connected is the board", () => {
    expect(taskProvider([at("clickup", "connected")])?.id).toBe("clickup");
    // Even beside a connected local list: the board has views to choose from.
    expect(taskProvider([at("taskwarrior", "connected"), at("clickup", "connected")])?.id).toBe("clickup");
  });

  test("another tracker connected, ClickUp never set up: that tracker", () => {
    /* The bug this fixes: a machine tracking work in Taskwarrior got an empty
       ClickUp board and an "Open in ClickUp" button. */
    expect(taskProvider([at("taskwarrior", "connected"), at("clickup", "needs-auth")])?.id).toBe("taskwarrior");
  });

  test("connected beats a refused token", () => {
    expect(taskProvider([at("taskwarrior", "connected"), at("clickup", "error")])?.id).toBe("taskwarrior");
  });

  test("a refused token is still the tracker when nothing else is", () => {
    // The Cards tab is where "ClickUp refused this token" gets read.
    expect(taskProvider([at("clickup", "error"), at("taskwarrior", "missing-tool")])?.id).toBe("clickup");
  });

  test("nothing set up is null; no answer is undefined", () => {
    expect(taskProvider([at("clickup", "needs-auth"), at("taskwarrior", "missing-tool")])).toBe(null);
    expect(taskProvider(null)).toBe(undefined);
    expect(taskProvider(undefined)).toBe(undefined);
    expect(taskProvider([])).toBe(undefined);
    expect(taskProvider([at("github", "connected")])).toBe(undefined);
  });

  test("it answers with the catalogue's row, not a copy", () => {
    const got = taskProvider([at("taskwarrior", "connected")]);
    expect(got?.title).toBe("Taskwarrior");
    expect(got?.kind).toBe("task");
  });
});

describe("providerTitle", () => {
  test("the catalogue's spelling", () => {
    expect(providerTitle("clickup")).toBe("ClickUp");
    expect(providerTitle("taskwarrior")).toBe("Taskwarrior");
  });
  test("a neutral word, never an id, when there is no provider to name", () => {
    expect(providerTitle(null)).toBe("the tracker");
    expect(providerTitle(undefined)).toBe("the tracker");
  });
});
