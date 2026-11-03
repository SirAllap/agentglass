/*
 * The terminal opens a pane only for a phone that may type.
 *
 * `/terminal/pty` needs `full` (server/src/auth.ts, FULL_GET). The Inbox
 * listed the Terminal for every pairing and the screen opened the socket for
 * every pairing, so a phone paired for `read` was walked into a pane whose
 * socket the server closed on arrival, and told the connection had been lost.
 *
 * The destination is in the bar for every pairing now, because the Terminal
 * screen is also where an `answer` phone answers gates waiting on you. So the claim moved
 * from "the list cuts it" to "the screen decides before the pane mounts": the
 * rule (`canRunAgents`) is run, and the screens are READ, the way
 * handoff-carries-an-id.test.ts reads them.
 */
import { describe, expect, test } from "bun:test";
import type { DeviceScope } from "../../shared/types.ts";
import { canRunAgents } from "../src/model/scope.ts";
import { BAR } from "../src/nav/bar.ts";

describe("canRunAgents", () => {
  test("full, and only full", () => {
    const scopes: DeviceScope[] = ["read", "answer", "full"];
    expect(scopes.filter(canRunAgents)).toEqual(["full"]);
  });
  test("no pairing is no", () => {
    expect(canRunAgents(null)).toBe(false);
    expect(canRunAgents(undefined)).toBe(false);
  });
});

describe("the bar", () => {
  test("offers the terminal to every pairing, and the screen decides what it shows", () => {
    expect(BAR.map((d) => d.route)).toContain("terminal");
  });
});

describe("the screens, read", () => {
  const read = (rel: string): Promise<string> => Bun.file(new URL(rel, import.meta.url)).text();

  test("the Terminal screen decides before the pane mounts", async () => {
    const src = await read("../app/(tabs)/terminal.tsx");
    const gate = src.indexOf("export default function TerminalScreen");
    const pane = src.indexOf("function TerminalPane");
    expect(gate).toBeGreaterThan(-1);
    expect(pane).toBeGreaterThan(gate);
    // The default export is the gate: it reads the scope and never the socket.
    const body = src.slice(gate, pane);
    expect(body).toContain("canRunAgents(host.scope)");
    expect(body).not.toContain("TerminalView");
    expect(body).not.toContain("useState");
  });

  test("a phone that may answer gets the gates waiting on you where the pane would be", async () => {
    const src = await read("../app/(tabs)/terminal.tsx");
    const start = src.indexOf("function TerminalRefused(");
    const end = src.indexOf("function TerminalPane(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    expect(body).toContain('scope === "answer"');
    expect(body).toContain("<GateCard");
    // And never the socket.
    expect(body).not.toContain("TerminalView");
  });

  test("every hand-off into the terminal checks the scope first", async () => {
    /* Each screen that calls `requestHandoff` guards the callback on
       `mayWrite` — the button is already hidden without it, and this is the
       second lock, for the callback that outlives the button. */
    for (const rel of ["../app/pr/[number].tsx", "../app/issue/[number].tsx", "../app/card/[id].tsx"]) {
      const src = await read(rel);
      const at = src.indexOf("requestHandoff({");
      expect(at, rel).toBeGreaterThan(-1);
      // The guard sits in the same callback, above the call.
      const callbackStart = src.lastIndexOf("useCallback(", at);
      const guard = src.slice(callbackStart, at);
      expect(guard, rel).toMatch(/!mayWrite\) return;/);
    }
  });
});
