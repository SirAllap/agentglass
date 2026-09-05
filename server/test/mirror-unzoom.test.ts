/**
 * A PHONE'S ZOOM COMES OFF WHEN THE PHONE IS GONE — even across a restart.
 *
 * A phone gets one pane, so a window with a split is zoomed for it. The zoom
 * belongs to the WINDOW, shared with whoever else is looking at that session,
 * and it was undone from an object held in memory: fine until this process is
 * not the one that put it there.
 *
 * Measured on the developer's machine after a day of reinstalls: two windows
 * sat zoomed, two panes each, with no phone attached anywhere and nothing left
 * that knew they should not be. "It stays like that even after I've left the
 * mobile app… I have to make a split pane and then it goes back to normal."
 *
 * Driven against a REAL tmux on a socket of its own, because the thing being
 * asserted is what tmux believes about a window, and a stand-in that answers
 * `zoomed: false` proves nothing about a flag it invented.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { reapMirrorSessions } from "../src/tmuxctl.ts";
import { recordMirrorLease, __forgetMirrorLeases, mirrorLeases } from "../src/mirrorlease.ts";
import { TEST_TERM } from "./tmuxTerm.ts";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAME = `agx-unzoom-${process.pid}`;
const SOCK = ["-f", "/dev/null", "-L", NAME];
const sh = (args: string[]) => Bun.spawnSync(["tmux", ...SOCK, ...args], { stdout: "pipe", stderr: "pipe" });
const out = (args: string[]) => sh(args).stdout.toString().trim();
const state = mkdtempSync(join(tmpdir(), "agx-unzoom-state-"));

beforeAll(() => {
  process.env.AGENTGLASS_STATE_DIR = state;
  __forgetMirrorLeases();
  sh(["new-session", "-d", "-s", "work", "-c", "/tmp", "-x", "200", "-y", "50"]);
  sh(["split-window", "-t", "work", "-c", "/tmp"]);
});

afterAll(() => {
  sh(["kill-server"]);
  try { rmSync(join(tmpdir(), `tmux-${process.getuid?.() ?? 0}`, NAME), { force: true }); } catch { /* gone */ }
  try { rmSync(state, { recursive: true, force: true }); } catch { /* gone */ }
});

const zoomFlag = () => out(["display", "-t", "work", "-p", "#{window_zoomed_flag}"]);
const ids = () => ({
  sessionId: out(["display", "-t", "work", "-p", "#{session_id}"]),
  windowId: out(["display", "-t", "work", "-p", "#{window_id}"]),
  paneId: out(["display", "-t", "work", "-p", "#{pane_id}"]),
});

test("the sweep takes off the zoom the record says a mirror applied", () => {
  const { sessionId, windowId, paneId } = ids();
  expect(out(["list-panes", "-t", "work", "-F", "x"]).split("\n").length, "two panes to zoom between").toBe(2);

  sh(["resize-pane", "-Z", "-t", paneId]);
  expect(zoomFlag(), "zoomed for the phone").toBe("1");

  /* The record a phone attach writes, and the session it named is already gone
     — which is exactly the state a restart finds. */
  recordMirrorLease({
    socket: SOCK, session: `agx-phone-1-${process.pid}`, token: "t", opened: Date.now(),
    zoomed: { sessionId, windowId, paneId },
  });

  reapMirrorSessions();
  expect(zoomFlag(), "and off again once nothing is on it").toBe("0");
  expect(mirrorLeases().length, "the record goes with it").toBe(0);
});

test("a zoom nobody wrote down is left alone", () => {
  /* tmux offers no way to tell a phone's zoom from a person's, so the record is
     the only thing that may authorise touching one. Without it, hands off. */
  const { paneId } = ids();
  expect(zoomFlag(), "starts flat").toBe("0");
  sh(["resize-pane", "-Z", "-t", paneId]);
  expect(zoomFlag()).toBe("1");

  recordMirrorLease({
    socket: SOCK, session: `agx-phone-2-${process.pid}`, token: "t", opened: Date.now(),
    zoomed: null,
  });
  reapMirrorSessions();
  expect(zoomFlag(), "somebody's own zoom stays theirs").toBe("1");
  sh(["resize-pane", "-Z", "-t", paneId]);
});

test("and a window the record names is only unzoomed if it is still on that pane", () => {
  /* The window may have moved on: a person zoomed something else in the
     meantime, and undoing "the zoom" would then undo theirs. */
  const { sessionId, windowId } = ids();
  expect(zoomFlag(), "starts flat").toBe("0");
  const panes = out(["list-panes", "-t", "work", "-F", "#{pane_id}"]).split("\n");
  const other = panes[1] ?? panes[0]!;
  sh(["resize-pane", "-Z", "-t", other]);
  expect(zoomFlag()).toBe("1");

  recordMirrorLease({
    socket: SOCK, session: `agx-phone-3-${process.pid}`, token: "t", opened: Date.now(),
    zoomed: { sessionId, windowId, paneId: panes[0]! === other ? panes[1]! : panes[0]! },
  });
  reapMirrorSessions();
  expect(zoomFlag(), "a different pane is zoomed now — not ours to undo").toBe("1");
  sh(["resize-pane", "-Z", "-t", other]);
});
