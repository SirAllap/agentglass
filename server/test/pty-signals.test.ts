// The shell the PTY bridge starts must get the same signal dispositions a
// terminal emulator would give it. CPython ignores SIGPIPE (and friends) for
// its own convenience, and an ignored disposition survives execve — so without
// an explicit reset the panel's shell, and every command run in it, would see
// EPIPE where a real terminal sees a quiet death on SIGPIPE.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const BRIDGE = join(import.meta.dir, "..", "src", "pty_bridge.py");
const PYTHON = Bun.which("python3") || Bun.which("python");

describe.if(!!PYTHON && process.platform === "linux")("pty bridge signal hygiene", () => {
  test("the shell starts with no inherited ignored signals", async () => {
    const proc = Bun.spawn([PYTHON!, BRIDGE, "sh", "-c", "grep SigIgn /proc/self/status"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    proc.kill();
    // The bridge relays the pty verbatim, so the grep line arrives with the
    // terminal's CRLF; only the mask itself matters.
    const mask = out.match(/SigIgn:\s*([0-9a-f]+)/)?.[1];
    expect(mask).toBeDefined();
    expect(BigInt(`0x${mask}`)).toBe(0n);
  });
});
