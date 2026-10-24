/*
 * The keyring row's states. A locked keyring is a quiet badge and a way to ask
 * again, never a disabled row (the person can fix it and retry); one that cannot
 * exist here disables the row and says why; a running move locks the switch so
 * a second click cannot start another rewrite of every stored token.
 */
import { describe, expect, test } from "bun:test";
import { keyringRow, credentialsWhere, moveFailed, type KeyringState } from "../src/lib/keyringRow.ts";

const st = (o: Partial<KeyringState>): KeyringState => ({ enabled: false, state: "ready", held: 0, ...o });

describe("keyringRow", () => {
  test("off and ready: switch off, usable, says the file is where secrets stay", () => {
    const v = keyringRow(st({}), null);
    expect(v).toMatchObject({ on: false, disabled: false, badge: null, checkAgain: false });
    expect(v.hint).toContain("0600");
  });

  test("on and ready: counts what is held, singular and plural", () => {
    expect(keyringRow(st({ enabled: true, held: 3 }), null).hint).toContain("3 secrets");
    expect(keyringRow(st({ enabled: true, held: 1 }), null).hint).toContain("1 secret held");
    expect(keyringRow(st({ enabled: true, held: 0 }), null).hint).toContain("No secret");
  });

  test("on and locked: quiet badge and Check again, switch still usable", () => {
    expect(keyringRow(st({ enabled: true, state: "locked", why: "keyring locked" }), null)).toMatchObject({ on: true, disabled: false, badge: "keyring locked", checkAgain: true });
  });

  test("off and locked: same badge, so Check again can clear it before turning on", () => {
    expect(keyringRow(st({ state: "locked", why: "keyring locked" }), null)).toMatchObject({ on: false, disabled: false, badge: "keyring locked", checkAgain: true });
  });

  test("unavailable: disabled, the server's reason is the one line, no Check again", () => {
    const v = keyringRow(st({ state: "unavailable", why: "the system keyring is supported on Linux only" }), null);
    expect(v).toMatchObject({ disabled: true, badge: null, checkAgain: false, hint: "The system keyring is supported on Linux only." });
  });

  test("unavailable without a reason still says something", () => {
    expect(keyringRow(st({ state: "unavailable" }), null).hint.length).toBeGreaterThan(10);
  });

  test("a move in flight: disabled, shows the target, says which way", () => {
    const into = keyringRow(st({}), true);
    expect(into).toMatchObject({ on: true, disabled: true });
    expect(into.hint).toContain("into the keyring");
    const back = keyringRow(st({ enabled: true }), false);
    expect(back).toMatchObject({ on: false, disabled: true });
    expect(back.hint).toContain("back into the file");
  });

  test("not known yet: off and disabled rather than a guess", () => {
    expect(keyringRow(null, null)).toMatchObject({ on: false, disabled: true });
  });
});

describe("credentialsWhere", () => {
  test("names the keyring only while the setting is on", () => {
    expect(credentialsWhere(st({ enabled: true }))).toBe("system keyring");
    expect(credentialsWhere(st({}))).toBe("file, owner only");
    expect(credentialsWhere(null)).toBe("file, owner only");
  });
});

describe("moveFailed", () => {
  test("reads as two sentences, whatever punctuation the reason came with", () => {
    expect(moveFailed("keyring locked")).toBe("Keyring locked. Nothing was moved.");
    expect(moveFailed("could not read it back.")).toBe("Could not read it back. Nothing was moved.");
  });
  test("no reason still says nothing moved", () => {
    expect(moveFailed(undefined)).toBe("The server did not answer. Nothing was moved.");
  });
});
