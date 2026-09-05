/*
 * The two minutes, and what the form used to spend them on.
 *
 * Pairing from outside the flat was watched being lost: three attempts and two
 * expiries, with somebody at the computer to help. The ticket lives 120 seconds
 * (TICKET_TTL_MS in server/src/pairing.ts) and the form asked for an address, a
 * twelve-character ticket id and six digits, typed on glass.
 *
 * `readPairingCode` had understood a whole `http://host:4010/?pair=<id>` URL
 * since the camera was written — it returns the ticket *and* the address — and
 * the manual form's ticket field was a bare `setTicket`. So the one string that
 * carries everything did nothing at all when pasted, and the address had to be
 * typed anyway.
 *
 * What is asserted here is the wiring and the arithmetic. That the *screen*
 * does it was checked the only way it can be — pasting into the emulator with
 * `adb`, reading the screenshot, and pairing against a real server end to end.
 * A green assertion about a function is not evidence about a screen.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TICKET_TTL_MS as SERVER_TTL } from "../../server/src/pairing.ts";
import { announce, installed, pairing } from "./npm-deps.ts";

announce("pair-paste.test.ts");

const { TICKET_TTL_MS, fmtLeft, leftOnTicket, readPairingCode } = pairing;

const source = readFileSync(join(import.meta.dir, "..", "app", "pair.tsx"), "utf8");
/** The same file with its block comments taken out. The prose is allowed to
 *  quote the sentence this screen no longer says; the code is not. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "");

describe.skipIf(!installed)("one string, both fields", () => {
  test("the URL behind the QR carries the address as well as the ticket", () => {
    expect(readPairingCode("http://127.0.0.1:4010/?pair=Xd-YMvOT4ZRw")).toEqual({
      ticket: "Xd-YMvOT4ZRw",
      origin: "http://127.0.0.1:4010",
    });
  });

  test("a link that lost its scheme on the way still splits", () => {
    // The shape a link arrives in after a chat app, a note, or being read out:
    // `http://` is the first thing to go and the query string is the last.
    expect(readPairingCode("192.168.1.20:4000/?pair=Ux9-mQ2bK1pA")).toEqual({
      ticket: "Ux9-mQ2bK1pA",
      origin: "http://192.168.1.20:4000",
    });
  });

  test("a link with no port means 4000, not 80", () => {
    // `url.origin` would answer `http://192.168.1.20`, which is port 80 — an
    // address that fails as "nothing answered" while pointing at the right
    // machine. The normaliser is what puts the port back.
    expect(readPairingCode("http://192.168.1.20/?pair=Ux9-mQ2bK1pA")?.origin)
      .toBe("http://192.168.1.20:4000");
  });

  test("a half-typed ticket is refused, so the field can keep what was typed", () => {
    // This is why the field only surrenders its text when an *origin* comes
    // back: `absorb` leaves anything else exactly as typed. A reader that
    // accepted "Ux9-m" would let the field rewrite itself mid-word.
    expect(readPairingCode("Ux9-m")).toBeNull();
    expect(readPairingCode("Ux9-mQ2bK1pA")).toEqual({ ticket: "Ux9-mQ2bK1pA" });
  });

  test("and a QR that is not ours is still nothing", () => {
    for (const junk of ["", "https://example.com/", "WIFI:S:home;T:WPA;P:hunter2;;", "hello world"]) {
      expect(readPairingCode(junk), junk).toBeNull();
    }
  });
});

describe.skipIf(!installed)("the clock is the computer's, not this phone's", () => {
  // A whole second, because an HTTP `Date` has no milliseconds — the header is
  // the computer's clock rounded down, and the arithmetic has to be written
  // against that rather than against a number that survives a round trip.
  const at = 1_786_042_150_000; // the server's expiresAt, its own wall clock
  const date = new Date(at - 90_000).toUTCString(); // what its Date header said

  test("a phone an hour fast still sees a minute and a half", () => {
    // The whole reason the header is read. `expiresAt` is meaningless in this
    // phone's frame; the difference between it and the computer's own "now" is
    // a duration, and a duration survives any skew.
    expect(leftOnTicket(at, date, at + 3_600_000)).toBe(90_000);
    expect(leftOnTicket(at, date, at - 3_600_000)).toBe(90_000);
  });

  test("with no header it falls back to this phone's clock", () => {
    // No worse than having no countdown: a runtime that cannot parse the
    // header lands exactly where the screen was before there was one.
    expect(leftOnTicket(at, null, at - 45_000)).toBe(45_000);
    expect(leftOnTicket(at, "not a date", at - 45_000)).toBe(45_000);
  });

  test("never negative, and never longer than a ticket lives", () => {
    expect(leftOnTicket(at, null, at + 5_000)).toBe(0);
    // A span longer than the TTL can only be a misread clock, and a countdown
    // that starts at nine hours is worse than one that starts at two minutes.
    expect(leftOnTicket(at, null, at - 9 * 3_600_000)).toBe(TICKET_TTL_MS);
  });

  test("the phone's copy of the lifetime is the server's", () => {
    // It cannot be imported — server/src/pairing.ts is node:crypto all the way
    // down — so it is duplicated, and held equal here.
    expect(TICKET_TTL_MS).toBe(SERVER_TTL);
  });
});

describe.skipIf(!installed)("mm:ss", () => {
  test("counts the way a person reads a clock", () => {
    expect(fmtLeft(120_000)).toBe("2:00");
    expect(fmtLeft(107_000)).toBe("1:47");
    expect(fmtLeft(9_400)).toBe("0:10");
    // Rounded up, so the last live second reads 0:01 and only a dead ticket
    // ever reads 0:00 — the number people act on is "is there any left".
    expect(fmtLeft(1)).toBe("0:01");
    expect(fmtLeft(0)).toBe("0:00");
    expect(fmtLeft(-5_000)).toBe("0:00");
  });
});

describe.skipIf(!installed)("what the screen is wired to", () => {
  test("the ticket field is not a bare setTicket", () => {
    // The bug, in one line. `onChangeText={setTicket}` is what shipped, and it
    // is why pasting the link into the field it belongs in did nothing.
    expect(source).not.toMatch(/onChangeText=\{setTicket\}/);
    expect(source).toContain("if (!absorb(text)) setTicket(text)");
    // The address field takes it too: it is the box people paste into by
    // mistake, and refusing it there is another lost two minutes.
    expect(source).toContain("if (!absorb(text)) setOrigin(text)");
  });

  test("the screen asks how long the invitation has left", () => {
    expect(source).toContain("/pair/info?ticket=");
  });

  test("the sixth digit submits, without a button that is under the keyboard", () => {
    // Android draws no Go key on a number-pad. This guard is the auto-submit's
    // and nothing else's — `submit` tests the trimmed value.
    expect(source).toMatch(/if \(!\/\^\\d\{6\}\$\/\.test\(code\)\) return;/);
  });

  test("an expiry is reported as a clock, not as a person who did not answer", () => {
    expect(code).not.toContain("Nobody answered at the computer");
    expect(code).toContain("That invitation has run out.");
  });
});
