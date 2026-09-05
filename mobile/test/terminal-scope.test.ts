/*
 * The terminal is offered only to a phone that may open one.
 *
 * `/terminal/pty` needs `full` (server/src/auth.ts, FULL_GET). The Inbox
 * listed the Terminal for every pairing and the screen opened the socket for
 * every pairing, so a phone paired for `read` was walked into a pane whose
 * socket the server closed on arrival, and told the connection had been lost.
 *
 * Three claims. The rule (`canRunAgents`) and the list it cuts
 * (`terminalDestinations`) are run. The screens are READ, the way
 * handoff-carries-an-id.test.ts reads them: the Terminal screen decides before
 * the pane mounts, and every hand-off that ends in the terminal checks the
 * scope before it puts a request on the letterbox.
 */
import { describe, expect, test } from "bun:test";
import type { DeviceScope } from "../../shared/types.ts";
import { canRunAgents } from "../src/model/scope.ts";
import { BAR, terminalDestinations, type Destination } from "../src/nav/bar.ts";

const all: Destination[] = [...BAR.filter((d) => d.route !== "index"), { route: "repos", label: "Source control" }];

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

describe("terminalDestinations", () => {
  test("a full phone keeps the star", () => {
    expect(terminalDestinations(all, "full").map((d) => d.route)).toContain("terminal");
    expect(terminalDestinations(all, "full")).toBe(all);
  });

  test("read and answer lose it, and nothing else", () => {
    for (const scope of ["read", "answer"] as DeviceScope[]) {
      const routes = terminalDestinations(all, scope).map((d) => d.route);
      expect(routes, scope).not.toContain("terminal");
      expect(routes, scope).toEqual(all.map((d) => d.route).filter((r) => r !== "terminal"));
    }
  });

  test("unknown is not 'draw it' here — the scope is in hand, not in the air", () => {
    // The opposite of taskDestinations, on purpose: nothing is being waited for.
    expect(terminalDestinations(all, undefined).map((d) => d.route)).not.toContain("terminal");
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

  test("the Inbox cuts the terminal from its list by scope", async () => {
    const src = await read("../app/(tabs)/index.tsx");
    expect(src).toMatch(/terminalDestinations\([\s\S]*?host\?\.scope\)/);
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
