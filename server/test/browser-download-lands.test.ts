/*
 * `download` clicked, the file was requested, and nothing ever landed.
 *
 * Measured through the CLI — which is the part that matters, because testing a
 * verb over the HTTP API does not test the verb an agent actually runs:
 *
 *     agentglass-browser download '#dl' <dir> --timeout-ms 12000
 *     -> "no download finished within 12000ms of clicking #dl"   (13s, empty dir)
 *
 * The click was real: the test server logged three requests for the file. What
 * never happened was the download. `download` arms `Browser.setDownloadBehavior`
 * with a directory, clicks, and then waits for `Page.downloadWillBegin` and
 * `Page.downloadProgress` to come back through the CDP event buffer — and
 * Electron takes a guest's download itself, on the session's `will-download`,
 * before the protocol is involved at all. Nothing in the app listened for that
 * event (grep: zero handlers anywhere), so the item met Electron's default and
 * CDP had nothing to report.
 *
 * The shell now remembers the directory the verb asked for, saves the file
 * there, and pushes the two events the waiting loop is already listening for.
 * Same shape as the printToPDF branch beside it and for the same reason: the
 * answer stops coming from the protocol without anything downstream needing to
 * learn that. The server orchestration and the CLI are untouched.
 *
 * After, through the same CLI call:
 *
 *     1s, and bajado.txt on disk containing AGX_DOWNLOAD_MARKER_5512
 *     — the marker the source file was written with, compared against it
 *
 * These are source assertions because the real thing needs Electron, a guest
 * process and a session that emits `will-download`. What they guard is the
 * wiring an integration test could not see anyway: that the two halves agree on
 * the event names, and that the path is remembered from the call the verb
 * already makes rather than from somewhere a rewrite could quietly drop.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const main = readFileSync(join(REPO, "electron", "main.js"), "utf8");
const drive = readFileSync(join(REPO, "server", "src", "browserdrive.ts"), "utf8");

/** main.js with its comments removed — several of them name the very strings
 *  these assertions are about, which would make an absence check meaningless
 *  and a presence check dishonest. */
const bare = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("a download that actually lands", () => {
  test("the shell listens for Electron's own download event", () => {
    expect(bare, "nothing listened for this at all before").toContain('"will-download"');
    expect(bare, "and the file is put where it was asked to go").toContain("setSavePath");
  });

  test("the directory comes from the call the verb already makes", () => {
    // Not a channel of its own: `download` arms Browser.setDownloadBehavior
    // and that is where the path is. A second way to say it is a second way
    // for the two halves to disagree.
    expect(bare).toContain('method === "Browser.setDownloadBehavior"');
    expect(bare).toContain("downloadPath");
  });

  test("both halves name the same two events", () => {
    // The waiting loop compares these strings. A rename on one side and not
    // the other is a verb that waits out its timeout with the file on disk.
    for (const ev of ["Page.downloadWillBegin", "Page.downloadProgress"]) {
      expect(bare, `${ev} is pushed by the shell`).toContain(ev);
      expect(drive, `${ev} is awaited by the verb`).toContain(ev);
    }
  });

  test("and on the states the loop acts on", () => {
    // `completed` ends it with a path; `canceled` ends it with an error.
    // Electron spells the second one with two Ls, which is exactly the kind of
    // difference that turns "the download was canceled" into a timeout.
    expect(bare).toContain('"completed"');
    expect(bare).toContain('"canceled"');
    expect(bare, "Electron's spelling is translated, not assumed").toContain('"cancelled"');
    expect(drive).toContain('=== "completed"');
    expect(drive).toContain('=== "canceled"');
  });

  test("a download nobody asked for is left alone", () => {
    // The handler is on the session, which is shared. A person saving a file
    // from a page must not have it silently redirected into an agent's folder.
    expect(bare).toContain("if (!dir) return");
  });

  test("the handler is wired once per session", () => {
    // Wiring it per call would stack listeners, and every extra one pushes a
    // duplicate pair of events into the buffer the loop reads.
    expect(bare).toContain("downloadWired");
  });
});
