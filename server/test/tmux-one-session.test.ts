/*
 * One tmux session for everything the person should see.
 *
 * The strip draws one session, so a window opened anywhere else is a tab nobody can see or open (named
 * agents went to a session called `agents` for exactly that reason). The names the app may put on its
 * socket are listed here, each with why; any other is red, and so is a NEW file that starts a session.
 *
 *   <root>            the app's session (`orbit` for a root called orbit): every tab and every agent window
 *   <root>-console    the console docked inside other views: an app panel, not a tab (moving it is post-release)
 *   <root>-bench<n>   a bench tab: an app panel, same reason
 *   agx-phone-*       grouped mirror of the session for a phone: shares its windows, dies with the client
 *   scratch           the lazygit popup: made by the person's tmux, `display-popup attach -t scratch`, never by the app
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { engineAttachArgv, engineConsoleArgv, benchSessionName, engineSessionName } from "../src/tmuxpane.ts";
import { agentSession } from "../src/agentops.ts";

const root = "/home/someone/code/orbit";
const allowed = (n: string): boolean =>
  n === "orbit" || n === "orbit-console" || /^orbit-bench\d{1,2}$/.test(n) || /^agx-phone-\d+-[a-z0-9]+$/.test(n) || n === "scratch";
const nameOf = (argv: string[] | null): string => argv![argv!.indexOf("-s") + 1]!;

describe("session names the app makes", () => {
  test("every one is in the allowed set", () => {
    for (const n of [nameOf(engineAttachArgv(root)), nameOf(engineConsoleArgv(root)), benchSessionName(root, 1), benchSessionName(root, 7), agentSession(root), "agx-phone-12-ab3x"]) {
      expect(allowed(n), n).toBe(true);
    }
    for (const n of ["agents", "6f1c9b52-0000-4000-8000-0123456789ab", "orbit-agents", "other"]) expect(allowed(n), n).toBe(false);
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
  // tmuxconf: a throwaway sandbox socket for validating a config. tmuxpane: the app's session, console, bench, window `into`.
  // tmuxrestore: re-makes the sessions that existed. tmuxctl: grouped phone mirrors and the attach fallback.
  test("a new file that starts a session is red until it is justified here", () => {
    expect(starters).toEqual(["tmuxconf.ts", "tmuxctl.ts", "tmuxpane.ts", "tmuxrestore.ts"]);
  });
});
