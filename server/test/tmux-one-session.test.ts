/*
 * One tmux session for everything the person should see, and windows inside it.
 *
 * The strip draws one session, so a window opened anywhere else is a tab nobody
 * can see or open (named agents went to a session called `agents` for exactly
 * that reason). The console and the bench used to be sessions of their own —
 * `<checkout>-console` and `<checkout>-bench<n>` — which made them invisible to
 * the strip and broke the rule that a workspace has ONE engine session.
 *
 * They are windows of that session now, named `console` and `bench-<n>`, and
 * the rule this file pins is the new one: the only sessions the app makes are
 * the checkout's own, an ephemeral VIEW of it per panel client (a session group
 * — see enginePanelArgv: a second client on the same session mirrors the first,
 * which is a bug this app already has), and a phone's mirror. Any other is red,
 * and so is a NEW file that starts a session.
 *
 *   <root>            the app's session (`orbit` for a root called orbit): every tab, every agent
 *                     window, the console and every bench tab — see the window names below
 *   agx-view-<pid>-x  a panel's view of <root>: same windows, its own current window, dies with the pty
 *   agx-phone-*       grouped mirror of the session for a phone: shares its windows, dies with the client
 *   scratch           the lazygit popup: made by the person's tmux, `display-popup attach -t scratch`, never by the app
 *
 * and the windows ON <root>:
 *
 *   console           the console docked inside other views: an app panel, not a tab of its own
 *   bench-<n>         a bench tab, one window per tab, keyed by the slot the client keeps
 *   (anything else)   the terminal's own windows, agent windows, the seat
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { benchWindowName, engineAttachArgv, engineSessionName, isPanelViewSession, CONSOLE_WINDOW } from "../src/tmuxpane.ts";
import { agentSession } from "../src/agentops.ts";

const root = "/home/someone/code/orbit";
const allowedSession = (n: string): boolean =>
  n === "orbit" || /^agx-view-\d+-[a-z0-9]+$/.test(n) || /^agx-phone-\d+-[a-z0-9]+$/.test(n) || n === "scratch";
const allowedWindow = (n: string): boolean => n === CONSOLE_WINDOW || /^bench-[1-9]\d?$/.test(n);
const nameOf = (argv: string[] | null): string => argv![argv!.indexOf("-s") + 1]!;

describe("session names the app makes", () => {
  test("every one is in the allowed set", () => {
    for (const n of [nameOf(engineAttachArgv(root)), agentSession(root), "agx-view-12-ab3x", "agx-phone-12-ab3x", "scratch"]) {
      expect(allowedSession(n), n).toBe(true);
    }
    for (const n of ["agents", "6f1c9b52-0000-4000-8000-0123456789ab", "orbit-agents", "other", "orbit-console", "orbit-bench1"]) {
      expect(allowedSession(n), n).toBe(false);
    }
  });

  /* The names the app used to make, and must not make again: a session per
     panel is what this change exists to end. They are asserted as REFUSED
     rather than merely absent from a list, so a reintroduction under either
     spelling is red. */
  test("the old console and bench session names are never names the app makes", () => {
    for (const n of ["orbit-console", "orbit-bench1", "shop-api-console", "shop-api-bench7"]) {
      expect(allowedSession(n), n).toBe(false);
    }
  });

  test("the console and every bench tab are windows of the one session", () => {
    expect(allowedWindow(CONSOLE_WINDOW)).toBe(true);
    for (const slot of [1, 7, 99]) expect(allowedWindow(benchWindowName(slot)), benchWindowName(slot)).toBe(true);
    // Neither of the old, session-shaped spellings is a window name.
    expect(allowedWindow("orbit-console")).toBe(false);
    expect(allowedWindow("orbit-bench1")).toBe(false);
  });

  test("a panel's view is recognised as one, and a checkout's session is not", () => {
    expect(isPanelViewSession("agx-view-12-ab3x")).toBe(true);
    expect(isPanelViewSession("orbit")).toBe(false);
    expect(isPanelViewSession("orbit-console")).toBe(false);
  });

  test("named agents open in the app's session", () => {
    expect(agentSession(root)).toBe(engineSessionName(root));
  });
});

describe("only the known files start a session", () => {
  const dir = new URL("../src/", import.meta.url).pathname;
  const starters = readdirSync(dir).filter((f) => f.endsWith(".ts")).filter((f) => {
    const text = readFileSync(dir + f, "utf8");
    return text.split("\n").some((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /["']new-session["']/.test(l));
  }).sort();
  // tmuxconf: a throwaway sandbox socket for validating a config. tmuxpane: the app's session, its
  // panel views and windows `into`. tmuxrestore: re-makes the sessions that existed. tmuxctl: grouped
  // phone mirrors and the attach fallback.
  test("a new file that starts a session is red until it is justified here", () => {
    expect(starters).toEqual(["tmuxconf.ts", "tmuxctl.ts", "tmuxpane.ts", "tmuxrestore.ts"]);
  });
});
