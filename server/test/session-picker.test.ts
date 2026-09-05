/**
 * Showing another tmux session in the strip — because a person asked, never
 * because the app decided.
 *
 * The strip shows the windows of the session its own client is attached to, so
 * a window opened anywhere else is invisible: "that tab doesn't show up in the terminal".
 * The app's first answer was to switch the client itself, and that took four
 * windows of somebody's own work off their screen at once — "I've completely
 * lost my tmux that had my work sessions in it". A person choosing is
 * the opposite act: they know where they are going, and the way back is one
 * more choice.
 *
 * Driven against a REAL tmux on a socket of its own, with `-f /dev/null` — on
 * this machine a named socket still reads ~/.tmux.conf, and continuum would
 * start restoring the developer's own sessions inside the test.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { switchClientToSession, killSessionByName, readFrame } from "../src/tmuxctl.ts";
import { TEST_TERM } from "./tmuxTerm.ts";
import { setLocked, isLocked } from "../src/tmuxlock.ts";
import { tmuxStateDir } from "../src/tmuxbin.ts";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOCK = `agx-picker-${process.pid}`;
const sock = ["-f", "/dev/null", "-L", SOCK];
const sh = (args: string[]) => Bun.spawnSync(["tmux", ...sock, ...args], { stdout: "pipe", stderr: "pipe" });
const out = (args: string[]) => sh(args).stdout.toString().trim();
const tty = () => out(["list-clients", "-F", "#{client_tty}"]).split("\n")[0] ?? "";
const where = () => out(["list-clients", "-F", "#{session_name}"]);

let client: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  sh(["new-session", "-d", "-s", "alfa", "-c", "/tmp"]);
  sh(["new-window", "-t", "alfa", "-c", "/tmp", "-n", "w2"]);
  sh(["new-session", "-d", "-s", "beta", "-c", "/tmp"]);
  sh(["new-session", "-d", "-s", "gamma", "-c", "/tmp"]);
  // A real attached client: `readFrame` resolves through `list-clients`, so
  // without one there is no frame at all and every assertion below is vacuous.
  /* TERM, because a test that builds its own pty IS a terminal emulator and
     tmux asks what kind. The house lint checks for exactly this. */
  client = Bun.spawn(["script", "-qfc", `tmux ${sock.join(" ")} attach -t alfa`, "/dev/null"],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, TERM: TEST_TERM } });
  for (let i = 0; i < 40 && !tty(); i++) await Bun.sleep(50);
});

afterAll(() => {
  /* By pid and then the server, in that order: killing the socket file does
     not kill the process, and this suite has left 216 tmux servers running
     once before. */
  try { client?.kill(); } catch { /* already gone */ }
  sh(["kill-server"]);
  /* And the socket FILE: `kill-server` ends the process and leaves the socket
     behind, so a suite run often enough silts up /tmp with dead ones. */
  try {
    rmSync(join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, SOCK), { force: true });
  } catch { /* never made, or already gone */ }
});

test("the frame carries EVERY session, not only the client's", () => {
  const f = readFrame({ pid: 0, socket: sock, session: "alfa", id: "", tty: tty() } as never);
  const names = (f?.sessions ?? []).map((x) => x.name).sort();
  expect(names, "the picker has nothing to offer without this").toEqual(["alfa", "beta", "gamma"]);
  // …with a count, so a person can tell an empty session from a busy one.
  expect(f?.sessions.find((x) => x.name === "alfa")?.windows).toBe(2);
  // And the strip itself still shows only where the client is.
  expect(f?.windows.length, "the strip is still the client's own session").toBe(2);
});

test("choosing another session moves the client, and back again", () => {
  expect(where()).toBe("alfa");
  expect(switchClientToSession(sock, tty(), "beta")).toBe(true);
  expect(where()).toBe("beta");
  /* The half that makes this different from the app doing it unasked. */
  expect(switchClientToSession(sock, tty(), "alfa")).toBe(true);
  expect(where(), "the way back has to work or this is a trap").toBe("alfa");
});

test("a session that does not exist moves nobody", () => {
  const before = where();
  switchClientToSession(sock, tty(), "not-a-session");
  expect(where()).toBe(before);
});

test("a dangerous name is refused before it reaches tmux", () => {
  /* The value comes off a page and ends up in a tmux target. */
  const before = where();
  for (const bad of ["beta; rm -rf /", "beta rm", "", "-beta"]) {
    expect(switchClientToSession(sock, tty(), bad), bad).toBe(false);
  }
  expect(where()).toBe(before);
});

test("no client tty, no switch", () => {
  expect(switchClientToSession(sock, "", "beta")).toBe(false);
});

test("ending a session from the picker actually ends it", () => {
  /* "There were two sessions with a tab open in root and that's it… it was a
     real struggle to end that session." A picker that can only take you somewhere is half a
     tool. */
  expect(out(["list-sessions", "-F", "#{session_name}"]).split("\n").sort()).toContain("gamma");
  expect(killSessionByName(sock, "gamma", where())).toBe(true);
  expect(out(["list-sessions", "-F", "#{session_name}"]).split("\n")).not.toContain("gamma");
});

test("but NEVER the session the client is on", () => {
  /* Ending it detaches the terminal somebody is looking at, and tmux decides
     where they land — the same "the app moved me" they were burned by. */
  const on = where();
  expect(killSessionByName(sock, on, on), "this would drop their terminal").toBe(false);
  expect(out(["list-sessions", "-F", "#{session_name}"]).split("\n")).toContain(on);
});

test("and a dangerous name ends nothing", () => {
  const before = out(["list-sessions", "-F", "#{session_name}"]).split("\n").length;
  for (const bad of ["beta; rm -rf /", "", "-beta", "bet", "beta:", "beta.0", "beta:0.0"]) {
    expect(killSessionByName(sock, bad, where()), bad).toBe(false);
  }
  /* `bet` matters most: a bare name prefix-matches its way onto `beta`, so the
     target is exact-match on purpose. `beta:` is the other way round the same
     wall: it is not equal to "beta", so it passed the client-on and lock checks
     as itself, and `-t =beta:` is then resolved BY TMUX to beta — the exact
     match did not help, because the string handed to it was a target, not a
     name. Measured on this socket before the name rule refused `:` and `.`:
     the count below came back one short. */
  expect(out(["list-sessions", "-F", "#{session_name}"]).split("\n").length).toBe(before);
});

/*
 * THE PADLOCK. "Can you add a padlock to lock some of them so they can't be
 * deleted, to avoid disasters." Driven through the same function the panel
 * calls, because a padlock the UI draws but the server does not honour is a
 * padlock painted on the door.
 */
test("a locked session cannot be ended, and unlocking lets it go", () => {
  sh(["new-session", "-d", "-s", "delta", "-c", "/tmp"]);
  const names = () => out(["list-sessions", "-F", "#{session_name}"]).split("\n");
  expect(names()).toContain("delta");

  setLocked("delta", true);
  expect(isLocked("delta")).toBe(true);
  expect(killSessionByName(sock, "delta", where()), "locked").toBe(false);
  expect(names(), "still there").toContain("delta");

  setLocked("delta", false);
  expect(killSessionByName(sock, "delta", where()), "unlocked").toBe(true);
  expect(names()).not.toContain("delta");
});

test("the lock is held by NAME, so it survives the session being remade", () => {
  /* The id changes; that is the whole reason the list is of names. */
  sh(["new-session", "-d", "-s", "epsilon", "-c", "/tmp"]);
  setLocked("epsilon", true);
  const idOf = (n: string) =>
    out(["list-sessions", "-F", "#{session_name} #{session_id}"])
      .split("\n").find((l) => l.startsWith(`${n} `))?.split(" ")[1] ?? "";
  const first = idOf("epsilon");
  sh(["kill-session", "-t", "=epsilon"]);           // ended by hand, outside the app
  sh(["new-session", "-d", "-s", "epsilon", "-c", "/tmp"]);
  const second = idOf("epsilon");
  expect(first, "it exists").not.toBe("");
  expect(second, "tmux made a new one").not.toBe(first);
  expect(killSessionByName(sock, "epsilon", where()), "the lock came back with it").toBe(false);
  setLocked("epsilon", false);
  sh(["kill-session", "-t", "=epsilon"]);
});

test("an unreadable lock file locks EVERYTHING rather than nothing", () => {
  const p = join(tmuxStateDir(), "locked-sessions.json");
  const saved = (() => { try { return readFileSync(p, "utf8"); } catch { return null; } })();
  writeFileSync(p, "{ this is not json");
  try {
    expect(isLocked("anything at all")).toBe(true);
    expect(killSessionByName(sock, "beta", where()), "fails closed").toBe(false);
  } finally {
    if (saved === null) rmSync(p, { force: true }); else writeFileSync(p, saved);
  }
  expect(isLocked("anything at all"), "readable again").toBe(false);
});
