/*
 * Which sessions the photograph is allowed to include.
 *
 * It used `validPaneName`, which guards the names WE generate for chat panes:
 * UUID-shaped, eight characters minimum. So the first real capture on a machine
 * using this held ONE session — the chat's — and had silently dropped `orbit`,
 * `scratch`, `probe` and `7`. With the terminal running on the engine those are
 * the only sessions anybody would miss after a reboot, which made the whole
 * feature look like it worked while restoring nothing that mattered.
 *
 * Pure, so it runs without a tmux: the name rule is the bug, not the capture.
 */
import { describe, expect, it } from "bun:test";
import { validSessionName } from "../src/tmuxpane.ts";

describe("a name the restore will photograph", () => {
  it("is any session a person would actually make", () => {
    for (const n of ["orbit", "scratch", "probe", "7", "orbit-web", "a", "my_work"]) {
      expect(validSessionName(n), n).toBe(true);
    }
  });

  it("is still refused when it could climb out of the restore directory", () => {
    /* The name becomes a directory under the restore dir, where the scrollback
       is written — that, and not its length, is what needs guarding. A space or
       a two-letter name is fine and is deliberately NOT here: refusing those is
       how the old rule dropped `orbit` and `7`. The control characters are
       written as escapes, because a raw one in a source file is invisible in a
       diff and is what the hygiene check exists to stop. */
    const bad = ["", "..", ".", "a/b", "-x", "x".repeat(65), "a\u0000b", "a\u001bb"];
    for (const n of bad) expect(validSessionName(n), JSON.stringify(n)).toBe(false);
  });

  it("keeps the UUID names working, since chat panes still use them", () => {
    expect(validSessionName("92c33be2-4a3f-492a-92c7-c1bb3be11f71")).toBe(true);
  });
});
