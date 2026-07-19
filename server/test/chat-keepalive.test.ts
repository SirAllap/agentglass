// A chat turn is silent for as long as the model thinks or a tool runs, and Bun
// closes a connection whose gaps exceed `idleTimeout` — the default 10s cut real
// turns off mid-answer, and the browser could only report a generic fetch
// failure. The server now raises that ceiling to Bun's maximum and, because even
// the maximum is shorter than a slow turn, writes a blank ndjson line while
// nothing else is happening.
//
// Both halves are pinned here against a deliberately tiny timeout, so the test
// proves the mechanism in a second rather than in four minutes — and without
// spawning a real `claude`, which costs money.
import { describe, expect, test } from "bun:test";
import { startKeepalive } from "../src/chat.ts";

/** Serve one silent-then-final ndjson response and read it back, standing in for
 *  a turn whose model is still thinking. `idleTimeout` is left at Bun's default
 *  — the 10 seconds that caused the bug — so this exercises the real thing; the
 *  quiet gap is sized just past it, since a lower timeout is not honoured
 *  precisely enough by Bun's timer wheel to test against. */
async function silentTurn(opts: { keepalive: boolean; quietMs: number }) {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const enc = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(JSON.stringify({ type: "system", subtype: "init" }) + "\n"));
          const stop = opts.keepalive ? startKeepalive(c, 2_000) : () => {};
          await Bun.sleep(opts.quietMs);
          stop();
          c.enqueue(enc.encode(JSON.stringify({ type: "result" }) + "\n"));
          c.close();
        },
      }), { headers: { "content-type": "application/x-ndjson" } });
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    // What the web client does: parse the non-blank lines, ignore the rest.
    return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  } finally {
    server.stop(true);
  }
}

// Both halves share one 16-second wall clock by running together, rather than
// costing the suite that long twice over.
describe("streaming a quiet turn", () => {
  test("only a keepalive survives a gap past the idle timeout", async () => {
    const quietMs = 16_000;
    const [without, with_] = await Promise.allSettled([
      silentTurn({ keepalive: false, quietMs }),
      silentTurn({ keepalive: true, quietMs }),
    ]);
    // The bug, reproduced: the turn is accepted, the first event arrives, and
    // then the socket dies before the answer does.
    expect(without.status).toBe("rejected");
    // The fix: the same gap, carried through to the real final event.
    expect(with_.status).toBe("fulfilled");
    expect(with_.status === "fulfilled" && with_.value.map((e) => e.type)).toEqual(["system", "result"]);
  }, 40_000);
});

describe("startKeepalive", () => {
  test("writes blank lines until stopped, and not after", async () => {
    const written: string[] = [];
    const dec = new TextDecoder();
    const stop = startKeepalive({ enqueue: (c) => { written.push(dec.decode(c)); } }, 20);
    await Bun.sleep(120);
    stop();
    const atStop = written.length;
    expect(atStop).toBeGreaterThan(1);
    // Every write is a line the ndjson reader skips, never a parseable event.
    expect(written.every((w) => w === "\n")).toBe(true);
    await Bun.sleep(80);
    expect(written.length).toBe(atStop);
  });

  test("stops itself when the stream is already gone", async () => {
    // `enqueue` throws once the controller is closed or cancelled. The timer
    // cannot win that race, so it has to survive losing it.
    let calls = 0;
    startKeepalive({ enqueue: () => { calls++; throw new Error("stream closed"); } }, 20);
    await Bun.sleep(120);
    expect(calls).toBe(1);
  });
});
