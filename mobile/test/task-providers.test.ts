/*
 * Whether this machine tracks work anywhere, and which tracker the Tasks tab
 * reads.
 *
 * The question this app was getting wrong is not "is ClickUp connected". It is
 * the general one — ClickUp is one task provider of several, and a phone that
 * reads ClickUp's board for somebody who tracks work in Taskwarrior, or in
 * nothing at all, is showing them somebody else's product.
 *
 * The bar's own answer to this question went away with the Issues fold: Tasks
 * is a destination for every machine now, because GitHub issues need no
 * provider. What the answer still decides is which SOURCE the pill offers —
 * see test/tasks-sources.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderId, ProviderState, ProviderStatus } from "../../shared/providers.ts";
import { providerTitle, taskProvider, tracksWork } from "../src/model/taskProviders.ts";

const at = (id: ProviderId, state: ProviderState): ProviderStatus => ({ id, state });

describe("tracksWork", () => {
  test("a connected tracker is a yes", () => {
    expect(tracksWork([at("clickup", "connected")])).toBe(true);
    expect(tracksWork([at("taskwarrior", "connected")])).toBe(true);
  });

  test("a connected Jira is a tracker now that the phone reads its board", () => {
    expect(tracksWork([at("clickup", "needs-auth"), at("jira", "connected")])).toBe(true);
    expect(taskProvider([at("clickup", "needs-auth"), at("jira", "connected")])?.id).toBe("jira");
    // A non-Jira tracker still wins the generic `tracker` slot, where the list is.
    expect(taskProvider([at("clickup", "connected"), at("jira", "connected")])?.id).toBe("clickup");
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

  test("a set-up ClickUp outranks another tracker's state, error included", () => {
    /* The bug this fixes: ClickUp's own notification poll got one 404, its
       state flipped to "error", and a connected Taskwarrior outranked it —
       the board a person had set up disappeared behind a tracker they never
       touched. ClickUp still counts as set up (see `setUp`), and the screen
       that reads the board is where the error shows, not this ranking. */
    expect(taskProvider([at("taskwarrior", "connected"), at("clickup", "error")])?.id).toBe("clickup");
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
