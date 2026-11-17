/*
 * The credential strip on a fresh tmux socket runs off the event loop.
 *
 * It used to run up to 7 sync spawns inside the first sync `tmux()` call per
 * socket. Now: one memoized async strip per socket, started from `tmux` and
 * `tmuxAsync`; only a verb that starts a pane waits for it (sync in `tmux`),
 * because a pane exec's at once and a later strip cannot reach it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { takeSyncStripTurn } from "../src/tmuxctl.ts";

const src = readFileSync(new URL("../src/tmuxctl.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const body = (name: string): string => {
  const i = src.indexOf(name);
  expect(i).toBeGreaterThan(-1);
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j);
};

test("the async strip is memoized per socket and never recurses into tmuxAsync", () => {
  const b = body("function stripGlobalBrowserCredentialsAsync(");
  expect(b).toContain("stripInFlight.get(key)");
  expect(b).toContain("stripInFlight.set(key, p)");
  expect(b).toContain("tmuxAnsweredAsync(");
  expect(b).not.toContain("tmuxAsync(");
  expect(b).not.toContain("Bun.spawnSync");
});

test("tmuxAsync starts the async strip and awaits it only before a pane-spawning verb", () => {
  const b = body("async function tmuxAsync(");
  expect(b).toContain("stripGlobalBrowserCredentialsAsync(socket)");
  expect(b).toContain("if (spawnsPane(args) && !(await stripping)");
  expect(b).not.toContain("stripGlobalBrowserCredentials(socket)");
});

test("sync tmux keeps the sync strip only for pane-spawning verbs", () => {
  const b = body("function tmux(socket");
  expect(b).toContain("if (spawnsPane(args)) {");
  expect(b).toContain("!syncStripOrKick(socket)");
  expect(b).toContain("else void stripGlobalBrowserCredentialsAsync(socket)");
});

import { spawnsPane } from "../src/tmuxctl.ts";

test("every verb not on the no-process allowlist strips first (prefixes and shell verbs too)", () => {
  for (const v of ["new-session", "new-s", "new", "neww", "split", "split-window", "respawn-p", "pipe-pane", "pipep",
    "display-popup", "popup", "source-file", "source", "command-prompt", "confirm-before", "run-shell", "if-shell", "bogus"]) {
    expect(spawnsPane([v])).toBe(true);
  }
  for (const v of ["display-message", "show-options", "show-environment", "set-option", "set-window-option", "list-panes",
    "capture-pane", "send-keys", "select-window", "resize-pane", "kill-window", "rename-window", "move-window",
    "has-session", "refresh-client", "clear-history", "copy-mode"]) {
    expect(spawnsPane([v])).toBe(false);
  }
});

test("a pane verb is refused when the strip did not land, after one retry without the cooldown gate", () => {
  for (const name of ["function tmux(socket", "async function tmuxAsync("]) {
    const b = body(name);
    expect(b).toContain("refused: the credential strip did not land");
    expect(b).toContain("return null");
  }
  expect(body("async function tmuxAsync(")).toContain("stripGlobalBrowserCredentialsAsync(socket, true)");
  expect(body("function tmux(socket")).toContain("syncStripOrKick(socket)");
});

test("the start ticks are read right after the pid, before the strip's awaits, and null is not memoized", () => {
  for (const name of ["function stripGlobalBrowserCredentialsAsync(", "function stripGlobalBrowserCredentials("]) {
    const b = body(name);
    expect(b.indexOf("startTicksOf(pid)")).toBeGreaterThan(-1);
    expect(b.indexOf("startTicksOf(pid)")).toBeLessThan(b.indexOf("for (const v of BROWSER_CREDENTIAL_VARS)"));
    expect(b).toContain("recordSwept(key, pid, ticks)");
  }
  expect(body("function recordSwept(")).toContain("ticks !== null");
});

test("themesync routes both source-file calls through the strip", () => {
  const t = readFileSync(new URL("../src/themesync.ts", import.meta.url), "utf8");
  expect(t).toContain("await credentialsStripped(tmuxTarget)");
  expect(t).toContain("await credentialsStripped(socket)");
});

test("A: a #( format in any arg makes a read verb spawn-class", () => {
  expect(spawnsPane(["display-message", "-p", "#(id)"])).toBe(true);
  expect(spawnsPane(["list-windows", "-F", "#(id)"])).toBe(true);
  expect(spawnsPane(["set-option", "status-right", "#(id)"])).toBe(true);
  expect(spawnsPane(["display-message", "-p", "#{pid}"])).toBe(false);
});

test("B: a clean strip with unreadable start ticks returns true and is not memoized", () => {
  for (const name of ["function stripGlobalBrowserCredentialsAsync(", "function stripGlobalBrowserCredentials("]) {
    const b = body(name);
    expect(b).not.toContain("return ticks !== null");
    expect(b.slice(b.indexOf("recordSwept(key, pid, ticks)"))).toContain("return true");
  }
  expect(body("function recordSwept(")).toContain("ticks !== null");
});

test("C: sync path makes one attempt, refuses, and kicks the async strip", () => {
  const k = body("function syncStripOrKick(");
  expect(k).toContain("void stripGlobalBrowserCredentialsAsync(socket, true, bin)");
  expect(k).not.toContain("stripGlobalBrowserCredentials(socket, true)");
  expect(body("export function credentialsStrippedSync(")).toContain("syncStripOrKick(socket, bin)");
  expect(body("function tmux(socket")).not.toContain("stripGlobalBrowserCredentials(socket, true)");
});

test("D: no pid is clean only when tmux says no server", () => {
  for (const name of ["function stripGlobalBrowserCredentialsAsync(", "function stripGlobalBrowserCredentials("]) {
    const b = body(name);
    expect(b).toContain("return noServer");
    expect(b).not.toContain("slowUntil.get(key) ?? 0);\n  }\n  for"); // old clean-by-clock answer is gone
  }
  expect(src).toContain("no server running|error connecting");
});

/* The pane engine's strip is tmuxctl's, not a second sync copy: it used to run
   up to 7 `Bun.spawnSync` on the loop and let a pane start after a failed strip. */
test("the pane engine reuses tmuxctl's fail-closed strip and keeps no sync copy", () => {
  const pane = readFileSync(new URL("../src/tmuxpane.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(pane).not.toContain("function stripGlobalBrowserCredentials");
  expect(pane).not.toContain("engineAnswered");
  expect(pane).toContain("credentialsStripped(engineSocketArgs(true), bin)");
  expect(pane).toContain("credentialsStrippedSync(engineSocketArgs(true), bin)");
  /* The only sync spawn left is the one tmuxSync exists for, labelled
     (`spawnSyncAs`) so the loop watch can name it. */
  expect(pane.match(/Bun\.spawnSync|spawnSyncAs\(/g)?.length).toBe(1);
});

test("the strip probes with the binary it is given, not a bare `tmux`", () => {
  expect(body("function pidProbeAsync(")).toContain("[bin, ...socket");
  expect(body("function tmuxAnsweredAsync(")).toContain("[bin, ...socket");
});

test("sync strip runs once per socket on the loop; later strips are async only", () => {
  const k = body("function syncStripOrKick(");
  expect(k).toContain("takeSyncStripTurn(key)");
  expect(k.indexOf("sweptAlready(")).toBeLessThan(k.indexOf("stripGlobalBrowserCredentials(socket, false, bin)"));
  // the turn is spent after the strip, and not when no server was swept (noServer)
  expect(k.indexOf("stripGlobalBrowserCredentials(socket, false, bin)")).toBeLessThan(k.indexOf("takeSyncStripTurn(key)"));
  expect(k).toContain("!sweptServers.has(key)");
  // a restarted server (swept entry dead) gets a new turn
  expect(body("function sweptAlready(")).toContain("syncStripTaken.delete(key)");
  expect(k).toContain("void stripGlobalBrowserCredentialsAsync(");
  expect(k).not.toContain("await");
  expect(body("function takeSyncStripTurn(")).toContain("taken.add(key)");
  // the async strip and its probe never spawn sync
  for (const name of ["function stripGlobalBrowserCredentialsAsync(", "async function tmuxAnsweredAsync(", "async function pidProbeAsync("]) {
    expect(body(name)).not.toMatch(/spawnSync/);
  }
});

test("model: the first strip on a socket gets the one sync turn, later ones never", () => {
  const taken = new Set<string>();
  expect(takeSyncStripTurn("-L a", taken)).toBe(true);
  expect(takeSyncStripTurn("-L a", taken)).toBe(false);
  expect(takeSyncStripTurn("-L a", taken)).toBe(false);
  expect(takeSyncStripTurn("-L b", taken)).toBe(true); // another socket has its own turn
  expect(takeSyncStripTurn("-L b", taken)).toBe(false);
});
