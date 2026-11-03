// Closing a watcher must not close its descriptor behind the stream's back.
// With a second close, the number was reused by the next pipe and the reader
// of a child's output hung or failed with EBADF (6 of 6 runs of this loop hung
// for 5 s; with the stream the only owner, 0 of 10).
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { openWatcher } from "../src/inotify.ts";

const openFds = () => readdirSync("/proc/self/fd").length;

test.skipIf(process.platform !== "linux")("a closed watcher leaves its descriptor to the stream, and later pipes still read", async () => {
  const before = openFds();
  for (let i = 0; i < 40; i++) {
    const w = openWatcher(() => {});
    expect(w).not.toBeNull();
    w!.add("/tmp");
    w!.close();
    const p = Bun.spawn(["echo", "x"], { stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    expect(out).toBe("x\n");
  }
  await Bun.sleep(50);
  expect(openFds() - before).toBeLessThanOrEqual(2);
}, 20000);
