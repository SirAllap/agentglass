// Bytes typed into the panel must all arrive, including the ones the kernel
// would not take on the first try.
//
// `os.write` returns how many bytes it actually took, and it is allowed to
// take fewer than it was given. Both ends of the bridge can do that: the pty
// master's input buffer is a few KB while the reads are 64, and a write that
// has already moved some bytes when a signal lands returns that short count
// rather than EINTR — so Python's own EINTR retry cannot help, and the bridge
// installs a SIGWINCH handler, which is precisely the signal that arrives
// while somebody drags the panel wider.
//
// A bare `os.write` drops the remainder in silence: no error, nothing logged,
// just a paste missing its tail or a repainting full-screen program with a
// hole in the middle of its frame.
//
// The short write is driven here rather than raced for. A test that pastes a
// large block and hopes the buffer fills passes on a fast machine and fails on
// a loaded one; stubbing `os.write` to take a fixed bite makes the property
// itself — every byte, however many calls it takes — the thing under test.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const BRIDGE = join(import.meta.dir, "..", "src", "pty_bridge.py");
const PYTHON = Bun.which("python3") || Bun.which("python");

/** Run write_all with os.write stubbed to accept `bite` bytes per call. */
async function drive(total: number, bite: number): Promise<{ got: number; calls: number }> {
  const script = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(BRIDGE)})
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

seen = bytearray()
calls = 0
real_write = os.write

def stub(fd, data):
    global calls
    calls += 1
    take = data[:${bite}]          # the kernel takes what fits and no more
    seen.extend(take)
    return len(take)               # ...and says so, which is the whole point

os.write = stub
try:
    bridge.write_all(7, bytes(${total}))
finally:
    os.write = real_write
real_write(1, ("%d %d" % (len(seen), calls)).encode())
`;
  const proc = Bun.spawn([PYTHON!, "-c", script], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (!out) throw new Error(`no output from the bridge: ${err}`);
  const [got, calls] = out.split(" ").map(Number);
  return { got: got!, calls: calls! };
}

describe.if(!!PYTHON)("the pty bridge writes every byte", () => {
  test("a write the kernel only takes a slice of is resumed, not abandoned", async () => {
    // 10 KB through a 1 KB-per-call kernel. One `os.write` would deliver a
    // tenth of a paste and report nothing wrong.
    const { got, calls } = await drive(10_000, 1_000);
    expect(got).toBe(10_000);
    expect(calls).toBe(10); // resumed from the offset each time, not restarted
  });

  test("a byte count that does not divide evenly still lands whole", async () => {
    // Off-by-one in the slice arithmetic shows up here and not above.
    const { got } = await drive(4_097, 4_096);
    expect(got).toBe(4_097);
  });

  test("a write the kernel takes in full costs exactly one call", async () => {
    // The loop must not cost a second syscall per write on the common path —
    // this runs for every keystroke and every frame the shell paints.
    const { got, calls } = await drive(512, 65_536);
    expect(got).toBe(512);
    expect(calls).toBe(1);
  });

  test("nothing to write is not a syscall", async () => {
    const { got, calls } = await drive(0, 4_096);
    expect(got).toBe(0);
    expect(calls).toBe(0);
  });

  test("a kernel that stops taking anything ends the loop instead of spinning", async () => {
    // A zero return with no exception is not a state POSIX promises a way out
    // of; looping on it would peg a core forever, which is worse than the lost
    // tail it was trying to avoid.
    const { got, calls } = await drive(100, 0);
    expect(got).toBe(0);
    expect(calls).toBe(1);
  });
});
