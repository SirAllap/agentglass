/*
 * What `wake()` is allowed to believe about a socket it cannot see the other
 * end of.
 *
 * The bug this file exists for shipped with a comment describing it. `wake()`
 * opened with "an open socket that is actually dead is the normal state after a
 * phone has been asleep … readyState lies in exactly this case", and the next
 * line was `if (socket && socket.readyState === 1) return;`.
 *
 * Measured on emulator-5554 before it was removed: freeze the app the way
 * Android's freezer does, let the peer go away without closing the TCP, unlock.
 * The app kept the dead socket, the server's census read `live: 0` while the
 * phone drew its connected dot, and every `{type:"alert"}` after that went to
 * nobody. The 20s poll kept the queue updating, so nothing looked wrong except
 * that the phone had stopped saying anything needed him — which is the entire
 * job of this app.
 *
 * These are behaviour tests rather than assertions about the source, because
 * the thing to pin is "a new socket exists", not the shape of the code that
 * makes one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openLive, type LiveState } from "../src/lib/live.ts";
import type { Host } from "../src/lib/host.ts";

const HOST: Host = {
  origin: "http://10.0.2.2:4321",
  token: "t",
  label: "fakebox",
  scope: "full",
  pairedAt: 0,
};

type Handler = ((e?: unknown) => void) | null;

/**
 * Enough of React Native's WebSocket to be wrong in the same way.
 *
 * `close()` moves readyState immediately and fires `onclose` a turn LATER, as
 * the real one does. That turn is where the second half of this lived: the
 * callback of a socket that had already been replaced was still reporting
 * itself, so the screen went offline and the backoff queued another connect on
 * top of the one already in flight.
 */
class FakeSocket {
  static made: FakeSocket[] = [];
  readyState = 0;
  closes = 0;
  onopen: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  onmessage: Handler = null;

  constructor(readonly url: string, _protocols?: unknown, readonly options?: unknown) {
    FakeSocket.made.push(this);
  }

  /** The server accepted the upgrade. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The peer went away and SAID so — a close frame or a FIN that arrives. */
  dropByPeer(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  close(): void {
    this.closes++;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: 1000 }));
  }
}

const real = globalThis.WebSocket;
beforeEach(() => {
  FakeSocket.made = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
});
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = real;
});

function start(): { states: LiveState[]; handle: ReturnType<typeof openLive> } {
  const states: LiveState[] = [];
  const handle = openLive(HOST, { onFrame: () => {}, onState: (s) => states.push(s) });
  return { states, handle };
}

describe("waking the live socket", () => {
  test("reconnects even when the socket it holds says it is open", async () => {
    const { states, handle } = start();
    const first = FakeSocket.made[0]!;
    first.accept();
    expect(states).toEqual(["connecting", "open"]);

    // The state the phone comes back to: readyState 1, and no peer at the other
    // end. Nothing has fired, because nothing was told.
    expect(first.readyState).toBe(1);
    handle.wake();

    expect(FakeSocket.made).toHaveLength(2);
    expect(first.closes, "the socket wake() replaced was left open").toBe(1);
    handle.close();
  });

  test("and the socket it replaced cannot report itself afterwards", async () => {
    const { states, handle } = start();
    FakeSocket.made[0]!.accept();
    handle.wake();
    FakeSocket.made[1]!.accept();

    // The replaced socket's onclose lands here, one turn after wake().
    await Promise.resolve();
    await Bun.sleep(700); // longer than the first backoff (500ms)

    expect(states, "a superseded socket reported the connection down").toEqual(
      ["connecting", "open", "connecting", "open"],
    );
    expect(FakeSocket.made, "the backoff opened a second connection on top of the live one")
      .toHaveLength(2);
    handle.close();
  });

  test("a socket that really did drop still brings the backoff with it", async () => {
    // The other half: `down()` must stay armed for the socket that IS current,
    // or a phone that walks out of the flat never comes back.
    const { states, handle } = start();
    FakeSocket.made[0]!.accept();
    FakeSocket.made[0]!.dropByPeer();
    expect(states).toEqual(["connecting", "open", "offline"]);

    await Bun.sleep(700);
    expect(FakeSocket.made).toHaveLength(2);
    handle.close();
  });

  test("and nothing reconnects after close()", async () => {
    const { handle } = start();
    FakeSocket.made[0]!.accept();
    handle.close();
    FakeSocket.made[0]!.dropByPeer();

    await Bun.sleep(700);
    expect(FakeSocket.made).toHaveLength(1);
  });
});
