import { describe, expect, test } from "bun:test";
import { BACKPRESSURE_HIGH_WATER, STALL_CLOSE_MS, broadcastTo } from "../src/broadcast.ts";

class FakeSocket {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(private buffered = 0) {}
  setBuffered(n: number) { this.buffered = n; }
  send(data: string): number { this.sent.push(data); return data.length; }
  getBufferedAmount(): number { return this.buffered; }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
}

describe("broadcastTo", () => {
  test("a client keeping up gets every frame", () => {
    const healthy = new FakeSocket(0);
    const dropped: FakeSocket[] = [];
    broadcastTo([healthy], "hello", (ws) => dropped.push(ws));
    expect(healthy.sent).toEqual(["hello"]);
    expect(dropped).toEqual([]);
  });

  test("a stalled client is skipped, not sent to, and never blocks a healthy one", () => {
    const stalled = new FakeSocket(BACKPRESSURE_HIGH_WATER + 1);
    const healthy = new FakeSocket(0);
    const dropped: FakeSocket[] = [];
    broadcastTo([stalled, healthy], "big frame", (ws) => dropped.push(ws));
    expect(stalled.sent).toEqual([]); // the whole point: never queued onto it
    expect(healthy.sent).toEqual(["big frame"]);
    expect(dropped).toEqual([]); // not closed yet — only just noticed as stalled
  });

  test("a client that stays stalled past STALL_CLOSE_MS gets closed and dropped", () => {
    const stalled = new FakeSocket(BACKPRESSURE_HIGH_WATER + 1);
    const dropped: FakeSocket[] = [];
    let clock = 1_000_000;
    const now = () => clock;

    broadcastTo([stalled], "frame 1", (ws) => dropped.push(ws), now);
    expect(dropped).toEqual([]); // first sighting: given a grace period

    clock += STALL_CLOSE_MS + 1;
    broadcastTo([stalled], "frame 2", (ws) => dropped.push(ws), now);

    expect(stalled.sent).toEqual([]); // never got a frame the whole time
    expect(stalled.closed).toEqual({ code: 1008, reason: "not draining" });
    expect(dropped).toEqual([stalled]);
  });

  test("a client that missed a frame is closed the instant it drains, well inside the grace period", () => {
    // It must reconnect to resync — see broadcast.ts's header comment and
    // useLive.ts:187 (ws.onclose schedules the reconnect) plus index.ts's
    // websocket open() handler (sends a fresh `initial` frame to every new
    // socket). Resuming silently would leave it holding a permanent gap.
    const flaky = new FakeSocket(BACKPRESSURE_HIGH_WATER + 1);
    const dropped: FakeSocket[] = [];
    let clock = 0;
    const now = () => clock;

    broadcastTo([flaky], "frame 1", (ws) => dropped.push(ws), now);
    expect(flaky.sent).toEqual([]); // missed this one
    expect(flaky.closed).toBeNull(); // not yet — only just noticed

    flaky.setBuffered(0); // caught up well before STALL_CLOSE_MS
    clock += 5; // nowhere near the 30s grace period
    broadcastTo([flaky], "frame 2", (ws) => dropped.push(ws), now);

    expect(flaky.sent).toEqual([]); // closed instead of being handed frame 2
    expect(flaky.closed).toEqual({ code: 1008, reason: "missed a broadcast" });
    expect(dropped).toEqual([flaky]);
  });

  test("a client that never misses is never touched", () => {
    const healthy = new FakeSocket(0);
    const dropped: FakeSocket[] = [];
    broadcastTo([healthy], "frame 1", (ws) => dropped.push(ws));
    broadcastTo([healthy], "frame 2", (ws) => dropped.push(ws));
    expect(healthy.sent).toEqual(["frame 1", "frame 2"]);
    expect(healthy.closed).toBeNull();
    expect(dropped).toEqual([]);
  });

  test("a throwing send removes the socket via onDrop", () => {
    const broken = new FakeSocket(0);
    broken.send = () => { throw new Error("gone"); };
    const dropped: FakeSocket[] = [];
    broadcastTo([broken], "frame", (ws) => dropped.push(ws));
    expect(dropped).toEqual([broken]);
  });

  test("a throwing getBufferedAmount is NOT caught here — the caller must guard it", () => {
    // Unlike send(), getBufferedAmount() is read with no try/catch around it
    // (the loop above calls it before deciding what to do with the socket).
    // index.ts's broadcast() is the caller, and it is the one that must not
    // leave a loopwatch mark open if this throws — see loopwatch.test.ts's
    // "the broadcast bug, reproduced directly".
    const broken = new FakeSocket(0);
    broken.getBufferedAmount = () => { throw new Error("dead socket"); };
    expect(() => broadcastTo([broken], "frame", () => {})).toThrow("dead socket");
  });
});

/*
 * Real proof, not inference: a real Bun.serve WebSocket server, a real TCP
 * client that stops reading at the OS level, and a real broadcast storm run
 * against it. Foreground only — this opens a real listening socket.
 */
describe("broadcastTo against a real Bun.serve socket", () => {
  test("a non-reading client's buffer stays bounded and the loop stays responsive", async () => {
    type Data = { tag: "stalled" | "healthy" };
    const clients = new Set<import("bun").ServerWebSocket<Data>>();
    const healthyReceived: string[] = [];

    const server = Bun.serve<Data>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const tag = new URL(req.url).searchParams.get("tag") === "stalled" ? "stalled" : "healthy";
        if (srv.upgrade(req, { data: { tag } })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(ws) { clients.add(ws); },
        close(ws) { clients.delete(ws); },
        message() { /* clients don't send anything in this test */ },
      },
    });

    try {
      const net = await import("node:net");
      const port: number = server.port ?? (() => { throw new Error("no port"); })();

      // The healthy client: a real WebSocket, reads normally.
      const healthy = new WebSocket(`ws://127.0.0.1:${port}/?tag=healthy`);
      await new Promise<void>((resolve, reject) => {
        healthy.onopen = () => resolve();
        healthy.onerror = reject;
      });
      healthy.onmessage = (ev) => healthyReceived.push(String(ev.data));

      // The stalled client: a raw TCP socket that completes the WS handshake
      // by hand, then calls pause() and never reads another byte — the thing
      // a backgrounded tab or a frozen peer looks like from the server's side.
      const key = Buffer.from("broadcast-test-key-16b!").toString("base64").slice(0, 24);
      const stalledSocket: import("node:net").Socket = await new Promise((resolve, reject) => {
        const sock = net.connect({ host: "127.0.0.1", port }, () => {
          sock.write(
            `GET /?tag=stalled HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`,
          );
        });
        sock.once("error", reject);
        sock.once("data", () => {
          // Handshake response arrived (101 Switching Protocols). From here on,
          // never read again — pause() stops consuming at the OS level, so the
          // kernel receive buffer fills and, eventually, so does the server's
          // write side for this socket.
          sock.pause();
          resolve(sock);
        });
      });

      // Wait for the stalled client's open() to register.
      await Bun.sleep(20);
      let stalledWs: import("bun").ServerWebSocket<Data> | undefined;
      for (const ws of clients) if (ws.data.tag === "stalled") stalledWs = ws;
      expect(stalledWs).toBeDefined();

      // Hammer: broadcast a large frame on an interval (not one tight
      // synchronous loop — real traffic is event-driven, and a tight loop
      // would prove nothing about whether a *timer* can still get in).
      const bigFrame = JSON.stringify({ type: "events", data: "x".repeat(64 * 1024) });
      let sentCount = 0;
      const hammer = setInterval(() => {
        broadcastTo(clients, bigFrame, (ws) => clients.delete(ws));
        sentCount++;
      }, 2);

      // While the storm runs, prove the loop is not blocked: a timer
      // scheduled for "now" must still fire close to on time.
      const timerDelays: number[] = [];
      for (let i = 0; i < 5; i++) {
        const scheduledAt = performance.now();
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            timerDelays.push(performance.now() - scheduledAt);
            resolve();
          }, 0);
        });
      }

      // Let the storm run long enough to try to overflow a non-reading
      // client's kernel socket buffer many times over.
      await Bun.sleep(300);
      clearInterval(hammer);
      await Bun.sleep(20);

      const finalBuffered = stalledWs!.getBufferedAmount();

      // The bound: broadcastTo never queues a second frame onto a socket
      // that is already over BACKPRESSURE_HIGH_WATER, so the buffer cannot
      // grow past the mark plus roughly one frame still being sent — regardless of
      // how many frames (`sentCount`, well over 50) were broadcast.
      expect(sentCount).toBeGreaterThan(50);
      expect(finalBuffered).toBeLessThanOrEqual(BACKPRESSURE_HIGH_WATER + bigFrame.length * 2);

      // The loop stayed responsive the whole time: every timer fired within
      // 50ms of its schedule, storm included.
      for (const d of timerDelays) expect(d).toBeLessThan(50);

      // The healthy client was never held up by the stalled one.
      expect(healthyReceived.length).toBeGreaterThan(0);

      healthy.close();
      stalledSocket.destroy();
    } finally {
      server.stop(true);
    }
  }, 10_000);
});
