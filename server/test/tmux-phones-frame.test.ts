/*
 * The desk should know a phone is attached to its tmux.
 *
 * A phone attaches on a mirror session of its own (`agx-phone-<n>-<id>`), and
 * from the desk that client is invisible: same windows, same panes, and a
 * window that shrinks or a pane that scrolls with nobody touching it. The
 * frame already knows every session a client is on, so the count is a filter
 * over that set, not a second tmux call.
 */
import { describe, expect, test } from "bun:test";
import { parseFrame, phonesAttached } from "../src/tmuxctl.ts";

const client = (tty: string, name: string) => `c\t${tty}\t${name}\t$1\t200\t50\t\t\txterm-256color`;
const WINDOW = "w\t$1\t@1\t1\tfish\t1\t\t\t200\t50";
const PANE = "p\t$1\t@1\t1\t%1\t0\t0\t199\t49\t1\t0\t/dev/pts/1";

describe("phones attached", () => {
  test("the desk alone is no phone", () => {
    const f = parseFrame([client("/dev/pts/1", "orbit"), WINDOW, PANE].join("\n"), "/dev/pts/1");
    expect(f).not.toBeNull();
    expect(phonesAttached(f!.attached)).toBe(0);
  });

  test("a client on a mirror session is one", () => {
    const f = parseFrame(
      [client("/dev/pts/1", "orbit"), client("/dev/pts/7", "agx-phone-1-ab12"), WINDOW, PANE].join("\n"),
      "/dev/pts/1",
    );
    expect(phonesAttached(f!.attached)).toBe(1);
  });

  test("two phones are two, and a session merely NAMED like one is not", () => {
    const names = new Set(["orbit", "agx-phone-1-ab12", "agx-phone-2-cd34", "agx-phone-notes"]);
    expect(phonesAttached(names)).toBe(2);
  });
});

const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();

describe("where the count is sent", () => {
  test("the tmux frame carries `phones`, and it is part of the shape that triggers a send", () => {
    expect(src).toContain("const phones = phonesAttached(");
    const shape = src.slice(src.indexOf("const shape = JSON.stringify(["));
    expect(shape.slice(0, shape.indexOf("\n"))).toContain("phones");
  });
});

const panel = await Bun.file(new URL("../../web/src/components/TerminalPanel.tsx", import.meta.url)).text();

describe("the panel", () => {
  test("reads the count off the frame and draws a chip only when it is above zero", () => {
    expect(panel).toContain('s.tmuxPhones = typeof f.phones === "number" ? f.phones : 0;');
    expect(panel).toContain("(sess?.tmuxPhones ?? 0) > 0 &&");
    expect(panel).toContain("phone attached");
  });
});
