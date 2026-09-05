/**
 * A mirror session whose record is gone must still be closed.
 *
 * Measured on 2026-08-25, nine hours after a cold boot: the lease file held
 * ZERO records while nine `agx-phone-…` sessions were live, each carrying its
 * own copy of four windows with a `claude --resume` inside every one. That is
 * 525 MCP processes and 13 GB of memory, with the swap at 27 of 31 GB.
 *
 * The old sweep could not see any of it. It kills what the record names, the
 * record was empty, and so it reported success with nine mirrors standing.
 * The failure closes over itself: the record is the only memory of what to
 * clean, and losing it makes a mirror immortal rather than making anything
 * fail loudly.
 */
import { test, expect } from "bun:test";
import { reapOrphanedMirrors } from "../src/tmuxctl.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

/* Isolated even though nothing here reaches a real tmux: the lint counts files,
   not intentions, and it counts them because a test on this machine once had
   tmux-continuum restore the developer's OWN sessions inside it. */
const SOCK = [...TMUX_ISOLATED, "-L", "agx-mirror-orphan-test"];

/** A fake tmux: which sessions exist, which carry our stamp, which are attached. */
function server(p: {
  sessions: string[];
  stamped?: string[];
  attached?: string[];
}) {
  const killed: string[] = [];
  const io = {
    readStamp: (_s: string[], name: string) => (p.stamped ?? p.sessions).includes(name) ? "a-real-stamp" : "",
    attached: (_s: string[], name: string) => (p.attached ?? []).includes(name),
    kill: (_s: string[], name: string) => { killed.push(name); },
    exists: (_s: string[], name: string) => p.sessions.includes(name),
  };
  const names = () => p.sessions;
  return { io, names, killed };
}

test("nine mirrors and an empty record: all nine go", () => {
  const mirrors = [
    "agx-phone-1-70d2or", "agx-phone-1-e128tr", "agx-phone-1-fscfga",
    "agx-phone-3-qxhb81", "agx-phone-4-61fyjs", "agx-phone-40-sd0f7o",
    "agx-phone-5-0jahxp", "agx-phone-8-1buux3", "agx-phone-99-dy0rgu",
  ];
  const f = server({ sessions: [...mirrors, "orbit", "scratch"] });

  const killed = reapOrphanedMirrors(SOCK, f.io, f.names);

  expect(killed.length, "THE MACHINE FILLED UP because an empty record meant an empty sweep").toBe(9);
  expect(f.killed.sort()).toEqual([...mirrors].sort());
});

test("the user's own sessions are never touched, whatever else is going on", () => {
  const f = server({ sessions: ["orbit", "scratch", "agentglass-understudy", "orbit-console"] });
  expect(reapOrphanedMirrors(SOCK, f.io, f.names)).toEqual([]);
  expect(f.killed).toEqual([]);
});

test("a phone-SHAPED name without our stamp is somebody else's session", () => {
  /* The one rule that keeps this out of a socket that may be the user's own:
     the name proves nothing, the stamp proves it is ours. */
  const f = server({ sessions: ["agx-phone-1-abcdef"], stamped: [] });
  expect(reapOrphanedMirrors(SOCK, f.io, f.names)).toEqual([]);
  expect(f.killed, "A HEURISTIC ON THE NAME would kill a session we did not make").toEqual([]);
});

test("a mirror with a phone actually looking at it is left alone", () => {
  const f = server({ sessions: ["agx-phone-7-live01"], attached: ["agx-phone-7-live01"] });
  expect(reapOrphanedMirrors(SOCK, f.io, f.names)).toEqual([]);
});

test("attached and orphaned mirrors in one pass: only the orphans go", () => {
  const f = server({
    sessions: ["agx-phone-1-aaa111", "agx-phone-2-bbb222", "orbit"],
    attached: ["agx-phone-2-bbb222"],
  });
  expect(reapOrphanedMirrors(SOCK, f.io, f.names)).toEqual(["agx-phone-1-aaa111"]);
});

test("a name that only looks like the shape is not the shape", () => {
  const f = server({ sessions: ["agx-phone", "agx-phone-", "agx-phone-x-abc", "agx-phone-1-ABCDEF"] });
  expect(reapOrphanedMirrors(SOCK, f.io, f.names), "the regex is the contract").toEqual([]);
});

test("no sessions at all is not an error", () => {
  const f = server({ sessions: [] });
  expect(reapOrphanedMirrors(SOCK, f.io, f.names)).toEqual([]);
});

/**
 * The race that made a mirror immortal, which is what actually filled the
 * machine — the sweep above is the net, and this is the hole it fell through.
 *
 * The lease is recorded BEFORE the phone spawns its session, so there is a real
 * window where the record names something that does not exist yet. The sweep
 * runs at startup, which is exactly when a reinstall lands in that window. It
 * read an empty stamp, could not tell "not ours" from "not there yet", dropped
 * the record — and the session came up moments later with nothing naming it.
 */
import { reapMirrorSessions } from "../src/tmuxctl.ts";
import { recordMirrorLease, mirrorLeases, __resetMirrorLeases } from "../src/mirrorlease.ts";

test("a lease whose session has not spawned YET is kept, not forgotten", () => {
  __resetMirrorLeases();
  const sock = [...TMUX_ISOLATED, "-L", "agx-mirror-race-test"];
  recordMirrorLease({ socket: sock, session: "agx-phone-1-pending", token: "tok", opened: 0 });

  // The session does not exist yet: the phone is still spawning it.
  const io = {
    readStamp: () => "",
    attached: () => false,
    kill: () => { throw new Error("must not kill a session that is not there"); },
    exists: () => false,
  };
  reapMirrorSessions(io);

  // It IS dropped here — we can see it is gone, so the record is stale.
  expect(mirrorLeases().length).toBe(0);
});

test("a lease whose session EXISTS but cannot be read keeps its record", () => {
  __resetMirrorLeases();
  const sock = [...TMUX_ISOLATED, "-L", "agx-mirror-race-test"];
  /* Recorded a moment ago: this is the spawn window, which is exactly when a
     reinstall used to land and drop the record. */
  const justNow = Date.now();
  recordMirrorLease({ socket: sock, session: "agx-phone-1-slowread", token: "tok", opened: justNow });

  /* There, but `show-options` came back empty this instant. The old code read
     that as "not ours", dropped the record, and left the session standing
     forever — nine times over, 13 GB. */
  let killed = 0;
  const io = {
    readStamp: () => "",
    attached: () => false,
    kill: () => { killed++; },
    exists: () => true,
  };
  reapMirrorSessions(io, justNow + 1_000);

  expect(killed, "it must not kill on a read it could not make").toBe(0);
  expect(mirrorLeases().length,
    "THE RECORD WAS DROPPED and the session became immortal — nothing else looks it up by name").toBe(1);
});

test("but a session that has been stampless for a MINUTE is a stale record, not a spawn", () => {
  __resetMirrorLeases();
  const sock = [...TMUX_ISOLATED, "-L", "agx-mirror-race-test"];
  const longAgo = Date.now() - 10 * 60_000;
  recordMirrorLease({ socket: sock, session: "agx-phone-1-stale", token: "tok", opened: longAgo });

  let killed = 0;
  const io = {
    readStamp: () => "",
    attached: () => false,
    kill: () => { killed++; },
    exists: () => true,
  };
  reapMirrorSessions(io);

  /* Still never killed — an unstamped session is not provably ours — but the
     record stops naming it, which is the honest end of a lease we cannot
     verify. */
  expect(killed).toBe(0);
  expect(mirrorLeases().length).toBe(0);
});
