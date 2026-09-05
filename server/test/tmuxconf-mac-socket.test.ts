/*
 * The config gate's throwaway tmux server has to be able to open its socket.
 *
 * On a Mac it could not. `os.tmpdir()` there is `/var/folders/<2>/<30>/T`, tmux
 * appends `tmux-<uid>/<socket>`, and the whole path went past the 104-byte
 * `sun_path` limit: `new-session` failed with "File name too long", the gate
 * marked the (perfectly good) config broken, and the pane engine never started.
 *
 * This suite cannot run on a Mac, so it states that machine's shape and checks
 * the placement decision, which is pure. The real-tmux half of the gate is
 * tmuxconf.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { validationSandbox, SOCKET_PATH_BUDGET } from "../src/tmuxconf.ts";

const NOW = 1757000000000;
const SOCKET = `agx-val-${NOW}`;
/** The shape macOS hands out: two random chars, thirty random chars, `T`. */
const MAC_TMP = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T";

describe("where the validation sandbox goes", () => {
  test("a macOS tmpdir would overflow sun_path, so the socket goes under /tmp", () => {
    const { sandbox, socketPath } = validationSandbox(NOW, SOCKET, MAC_TMP, 501);
    // Prove the premise first: the preferred place is over budget. It is 100
    // bytes — under macOS's 104, but by too little to trust a modelled path.
    const preferred = `${MAC_TMP}/agx-cc-${NOW}/tmux-501/${SOCKET}`;
    expect(Buffer.byteLength(preferred)).toBe(100);
    expect(Buffer.byteLength(preferred)).toBeGreaterThan(SOCKET_PATH_BUDGET);
    expect(sandbox).toBe(`/tmp/agx-cc-${NOW}`);
    expect(socketPath).toBe(`/tmp/agx-cc-${NOW}/tmux-501/${SOCKET}`);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_PATH_BUDGET);
  });

  test("a tmpdir that fits is kept — the fallback is measured, not decided by platform", () => {
    const { sandbox, socketPath } = validationSandbox(NOW, SOCKET, "/tmp", 1000);
    expect(sandbox).toBe(`/tmp/agx-cc-${NOW}`);
    expect(socketPath).toBe(`/tmp/agx-cc-${NOW}/tmux-1000/${SOCKET}`);
    // A redirected TMPDIR that still fits is honoured too: the suites that
    // isolate tmux by pointing TMPDIR at scratch depend on that.
    const scratch = validationSandbox(NOW, SOCKET, "/tmp/agx-scratch-4242", 1000);
    expect(scratch.sandbox).toBe(`/tmp/agx-scratch-4242/agx-cc-${NOW}`);
  });

  test("a Linux box with a long TMPDIR gets the same fallback", () => {
    const long = "/home/somebody/.cache/some-very-long-application-name/tmp/nested/deeper/still";
    const { sandbox } = validationSandbox(NOW, SOCKET, long, 1000);
    expect(sandbox).toBe(`/tmp/agx-cc-${NOW}`);
  });

  test("the budget sits clear of the smaller sun_path of the two platforms", () => {
    // 104 on macOS. A one-digit-longer uid or a longer tmpdir must not be the
    // difference between a gate that runs and one that reports every config
    // broken, so the budget is not the limit itself.
    expect(SOCKET_PATH_BUDGET).toBeLessThanOrEqual(104 - 10);
  });
});
