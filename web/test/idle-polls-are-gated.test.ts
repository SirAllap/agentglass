/*
 * Nothing polls from a view you are not looking at.
 *
 * Every panel in this app stays mounted when you switch away from it — that is
 * deliberate, and it is what makes coming back instant. The cost is that a
 * `setInterval` written inside one keeps running for as long as the app is
 * open, whether or not anybody is looking, whether or not the window is even on
 * screen. Measured on a cockpit parked on the Terminal: the pull request panel
 * alone was asking git about a branch nobody had open ~158,000 times a day.
 *
 * `usePoll(active, fn, ms)` is the answer this repo already had: it stops when
 * the view is not active, stops while the document is hidden, and refreshes the
 * moment the window comes back. This file is the lock that keeps the three
 * panels that were missing it from drifting back.
 *
 * Asserted against the source rather than by running the effects, because there
 * is no DOM in these suites — bun test, no jsdom — so no effect ever runs here.
 * A bare `setInterval` in one of these files is exactly the shape that was
 * wrong, so its absence is the thing worth pinning.
 */
import { describe, expect, test } from "bun:test";

const src = (rel: string) => Bun.file(new URL(`../src/${rel}`, import.meta.url)).text();

describe("the dashboard's own polls", () => {
  test("Alerts polls through usePoll and holds no interval of its own", async () => {
    const text = await src("components/Alerts.tsx");
    expect(text).toContain("usePoll(active");
    expect(text).not.toContain("setInterval(");
  });

  test("Sessions polls through usePoll and holds no interval of its own", async () => {
    const text = await src("components/Sessions.tsx");
    expect(text).toContain("usePoll(active");
    expect(text).not.toContain("setInterval(");
  });

  test("the dashboard hands both of them its own active flag", async () => {
    const text = await src("components/DashboardView.tsx");
    expect(text).toContain("<Alerts alerts={alerts} agents={agents} active={active}");
    expect(text).toContain("<Sessions provider={filter.provider} active={active} />");
  });
});

describe("panels found still holding a bare interval", () => {
  // ChatPanel's "which sessions are mid-turn" poll predated usePoll and was
  // never moved over: twenty requests a minute for a chat tab nobody was
  // looking at. RunningPanes, AgentsPane, PluginsPane, CommandLog and
  // RemoteAccessPane gated on `open` but still ran their own `setInterval`,
  // so they stopped when the panel closed but not when the window lost focus
  // — the same half of the fix Alerts and Sessions already had above.
  test.each([
    "components/ChatPanel.tsx",
    "components/RunningPanes.tsx",
    "components/AgentsPane.tsx",
    "components/PluginsPane.tsx",
    "components/CommandLog.tsx",
    "components/RemoteAccessPane.tsx",
  ])("%s polls through usePoll and holds no interval of its own", async (rel) => {
    const text = await src(rel);
    expect(text).toContain("usePoll(open");
    expect(text).not.toContain("setInterval(");
  });
});

describe("the pull request panel's git poll", () => {
  test("stops when the view is not on screen, and restarts when it is", async () => {
    const text = await src("components/PrPanel.tsx");
    // The guard…
    expect(text).toContain("if (!active || !root || !branch) return;");
    // …and the dependency that makes it a pause rather than a one-way door. A
    // guard without it would never re-run the effect on the way back in, which
    // would leave the count stale instead of merely un-polled — a feature lost
    // rather than a cost saved.
    expect(text).toContain("}, [active, root, detail?.headRefName]);");
  });
});
