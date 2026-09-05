/*
 * The observer is not photographed, and a photograph from before is not
 * replayed as the chat.
 *
 * The Lantern's chat was killed at 16:27 and came back at 16:36:28, one
 * second after the server restarted — from the restore's picture of the
 * engine, replayed through `sh -c`, one `sh -c` deeper than the time before
 * ("sh -c sh -c claude --name Lantern …"). A chat opened for a look at the
 * field NOW is not something a restart should bring back.
 */
import { describe, expect, test } from "bun:test";
import { runArgs, type CapturedPane } from "../src/tmuxrestore.ts";
import { LANTERN_PROMPT_MARK } from "../src/lanternmark.ts";

const pane = (startCommand: string): CapturedPane =>
  ({ id: "%1", index: 0, path: "/w", command: "sh", startCommand } as unknown as CapturedPane);

describe("the restore and the Lantern's chat", () => {
  test("a pane started with the Lantern's own prompt comes back as a shell, never as the chat", () => {
    const chat = pane(`/usr/bin/claude --name Lantern "${LANTERN_PROMPT_MARK}: you read the field"`);
    expect(runArgs("all", chat)).toEqual([]);
    const shell = pane("vim notes.md");
    expect(runArgs("all", shell)).toEqual(["sh", "-c", "vim notes.md"]);
  });

  test("the capture leaves such a pane out of the picture, and a window or session with nothing else goes with it", async () => {
    const src = await Bun.file(new URL("../src/tmuxrestore.ts", import.meta.url)).text();
    const at = src.indexOf("export async function captureLayout(");
    const body = src.slice(at, src.indexOf("return writeMerged(sessions, now);", at));
    expect(body).toContain("if (startCommand.includes(LANTERN_PROMPT_MARK)) continue;");
    expect(body).toContain("if (panes.length) out.push({ ...w, panes });");
    expect(body).toContain("if (out.length) sessions.push({ name, windows: out });");
  });
});
