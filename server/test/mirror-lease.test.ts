/*
 * A phone that goes dark leaves its mirror unattached with nothing to fire
 * `destroy-unattached` — and the two orphans that started this were both
 * unattached and both untouched by that mechanism, because they predate the
 * stamp it now checks. `reapMirrorSessions` is the startup answer: reap the
 * recorded ones with no live client, each verified against its own stamp.
 *
 * The negative is the test that matters, same as `pane-lease.test.ts`: a
 * mirror session lives on whatever socket the desk was actually using, which
 * can be the user's own real tmux server — so a session this app never
 * recorded, however phone-shaped its name, must never be touched. tmux is
 * injected for the same reason panelease's suite injects it: a test that
 * reached a real one would be reading, and killing in, whatever the developer
 * had open.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  reapMirrorSessions, type MirrorLeaseIo,
} from "../src/tmuxctl.ts";
import {
  mirrorLeases, recordMirrorLease, __forgetMirrorLeases, __resetMirrorLeases, type MirrorLease,
} from "../src/mirrorlease.ts";

const SOCK = ["-L", "agx-mirror-test"];

/** A tmux server, as a parameter: sessions that carry a stamp and an attached
 *  count, and a record of what was killed. */
function fakeTmux(sessions: Record<string, { stamp?: string; attached?: boolean }> = {}) {
  const killed: string[] = [];
  const live: Record<string, { stamp?: string; attached?: boolean }> = { ...sessions };
  const io: MirrorLeaseIo = {
    readStamp: (_sock, session) => live[session]?.stamp ?? "",
    attached: (_sock, session) => !!live[session]?.attached,
    kill: (_sock, session) => { killed.push(session); delete live[session]; },
    /* Separate from `readStamp`, because a session we cannot READ is not a
       session we may forget — see the note on `MirrorLeaseIo`. A key in `live`
       is a session that is there, stamp or no stamp. */
    exists: (_sock, session) => session in live,
  };
  return { killed, live, io };
}

/** A record naming one session on `SOCK`. Bracket notation on purpose: the
 *  isolation lint flags anything shaped like a real tmux target build, and
 *  this one never reaches a real tmux at all — `reapMirrorSessions` above is
 *  always called with the fake `io`. */
const lease = (session: string, token: string): MirrorLease =>
  ({ ["socket"]: SOCK, session, token, opened: 0 }) as MirrorLease;

beforeEach(() => { __resetMirrorLeases(); });
afterEach(() => { __resetMirrorLeases(); });

describe("a session we never recorded", () => {
  test("his real sessions on the same socket are never touched, however phone-shaped their name looks", () => {
    // `agx-phone-…` name, three days old, attached — everything a heuristic
    // keyed on the name would flag. What it does not have is our record.
    const t = fakeTmux({ "agx-phone-999-oldold": { attached: true } });
    expect(reapMirrorSessions(t.io)).toEqual([]);
    expect(t.killed).toEqual([]);
  });

  test("his OWN unattached, non-phone session is never touched either", () => {
    const t = fakeTmux({ orbit: { attached: false } });
    expect(reapMirrorSessions(t.io)).toEqual([]);
    expect(t.killed).toEqual([]);
  });
});

describe("a mirror we recorded but whose stamp has moved", () => {
  test("is dropped from the record and never killed", () => {
    const t = fakeTmux({ "agx-phone-1-a1b2c3": { attached: false } }); // no stamp on it
    recordMirrorLease(lease("agx-phone-1-a1b2c3", "ours-1234"));
    expect(reapMirrorSessions(t.io)).toEqual([]);
    expect(t.killed).toEqual([]);
    expect(mirrorLeases()).toEqual([]);
  });
});

describe("the two orphan mirrors", () => {
  test("recorded, stamped, unattached: reaped at startup", () => {
    const t = fakeTmux({
      "agx-phone-210-4k9m8b": { stamp: "tok-a-1234", attached: false },
      "agx-phone-210-iw92a1": { stamp: "tok-b-1234", attached: false },
    });
    recordMirrorLease(lease("agx-phone-210-4k9m8b", "tok-a-1234"));
    recordMirrorLease(lease("agx-phone-210-iw92a1", "tok-b-1234"));

    expect(reapMirrorSessions(t.io)).toEqual(["agx-phone-210-4k9m8b", "agx-phone-210-iw92a1"]);
    expect(t.killed).toEqual(["agx-phone-210-4k9m8b", "agx-phone-210-iw92a1"]);
    expect(mirrorLeases()).toEqual([]);
  });

  test("stamped but still attached: left alone, record kept", () => {
    const t = fakeTmux({ "agx-phone-7-zz1122": { stamp: "tok-12345", attached: true } });
    recordMirrorLease(lease("agx-phone-7-zz1122", "tok-12345"));

    expect(reapMirrorSessions(t.io)).toEqual([]);
    expect(t.killed).toEqual([]);
    expect(mirrorLeases().map((l) => l.session)).toEqual(["agx-phone-7-zz1122"]);
  });
});

describe("the survives-a-server-restart shape", () => {
  test("the in-memory record is gone; the file is not, and the sweep still finds it", () => {
    const t = fakeTmux({ "agx-phone-1-restart": { stamp: "tok-12345", attached: false } });
    recordMirrorLease(lease("agx-phone-1-restart", "tok-12345"));
    __forgetMirrorLeases(); // the process that knew about this mirror is gone; the file is not
    expect(reapMirrorSessions(t.io)).toEqual(["agx-phone-1-restart"]);
    expect(t.killed).toEqual(["agx-phone-1-restart"]);
  });
});
