/*
 * Turning push on from the phone, without a phone.
 *
 * The one step no container can perform is the real `PushManager.subscribe`
 * against a real push service — that needs a device and a network this machine
 * does not have. Everything either side of it can be driven here, and is:
 * which of the three failures happened, what order the two ends are told in,
 * and what actually gets handed to `subscribe()`.
 *
 * That last one is worth the trouble. `applicationServerKey` accepts a string
 * without complaint and then fails at subscribe time with a message naming
 * neither the key nor the format — the kind of thing that costs an evening on
 * a phone with no console attached.
 */
import { describe, expect, it } from "bun:test";
import {
  decodeKey, deviceLabel, pushCopy, pushStateOf,
  currentPushState, enablePush, disablePush,
  isApplePortable, needsHomeScreen,
  type PushEnv, type PushState,
} from "../src/lib/webpush.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1";
// iPadOS 13+ reports a desktop Safari string: no "iPad" anywhere in it.
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15";
const MAC = IPAD;

// A real VAPID public key shape: uncompressed P-256, 65 bytes, leading 0x04.
const KEY = "BFFcPW6545a5BNP-yn9U_c0MwemXvzddylFa0KbDtANfRTa-OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q";

interface Calls {
  registered: string[];
  subscribedWith: { userVisibleOnly: boolean; applicationServerKey: unknown }[];
  toldServer: { sub: unknown; label: string }[];
  toldServerToForget: string[];
  browserUnsubscribed: number;
  permissionAsked: number;
  order: string[];
}

function fakeEnv(over: Partial<PushEnv> & {
  existing?: { endpoint: string } | null;
  serverTakesIt?: { ok: boolean; error?: string };
  registerThrows?: boolean;
  subscribeThrows?: string;
} = {}) {
  const calls: Calls = {
    registered: [], subscribedWith: [], toldServer: [], toldServerToForget: [],
    browserUnsubscribed: 0, permissionAsked: 0, order: [],
  };
  let current = over.existing ?? null;

  const registration = {
    pushManager: {
      getSubscription: async () => (current
        ? {
          endpoint: current.endpoint,
          toJSON: () => ({ endpoint: current!.endpoint, keys: { p256dh: "p", auth: "a" } }),
          unsubscribe: async () => {
            calls.order.push("browser-unsubscribe");
            calls.browserUnsubscribed++;
            current = null;
            return true;
          },
        }
        : null),
      subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: unknown }) => {
        if (over.subscribeThrows) throw new Error(over.subscribeThrows);
        calls.order.push("browser-subscribe");
        calls.subscribedWith.push(o);
        current = { endpoint: "https://push.example/new" };
        return {
          endpoint: current.endpoint,
          toJSON: () => ({ endpoint: current!.endpoint, keys: { p256dh: "p", auth: "a" } }),
          unsubscribe: async () => { calls.browserUnsubscribed++; current = null; return true; },
        };
      },
    },
  };

  const env: PushEnv = {
    sw: {
      register: async (url: string) => {
        if (over.registerThrows) throw new Error("no service worker here");
        calls.registered.push(url);
        return registration as never;
      },
      ready: Promise.resolve(registration as never),
    },
    hasPushManager: true,
    permission: "default",
    requestPermission: async () => { calls.permissionAsked++; return "granted"; },
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile",
    maxTouchPoints: 5,
    standalone: false,
    getKey: async () => ({ key: KEY }),
    subscribe: async (sub: unknown, label: string) => {
      calls.order.push("server-subscribe");
      calls.toldServer.push({ sub, label });
      return over.serverTakesIt ?? { ok: true };
    },
    unsubscribe: async (endpoint: string) => {
      calls.order.push("server-unsubscribe");
      calls.toldServerToForget.push(endpoint);
      return { ok: true };
    },
    ...over,
  };
  return { env, calls };
}

describe("the key the browser is given", () => {
  it("becomes bytes, because a string is silently accepted and then fails", async () => {
    const bytes = decodeKey(KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    // Uncompressed P-256. A browser rejects anything else outright.
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });

  it("reads it padded, unpadded, or mis-padded", async () => {
    // A 65-byte key is 88 characters and needs no padding, so any that turns
    // up came from something that added its own — and the only form that would
    // actually throw without normalising is the over-padded one. Which is the
    // only reason the normalising is there; the rest of this is arithmetic
    // that happens to agree.
    expect(Array.from(decodeKey("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(decodeKey("AQIDBA=="))).toEqual([1, 2, 3, 4]);
    expect(Array.from(decodeKey("AQID="))).toEqual([1, 2, 3]);
    // base64url's two substitutions, which plain atob does not know.
    expect(Array.from(decodeKey("-_8"))).toEqual([251, 255]);
  });

  it("is handed to subscribe() as bytes, not as the string it arrived as", async () => {
    const { env, calls } = fakeEnv({ permission: "granted" });
    await enablePush(env);
    const key = calls.subscribedWith[0]!.applicationServerKey;
    expect(key).toBeInstanceOf(Uint8Array);
    expect((key as Uint8Array).length).toBe(65);
  });
});

describe("which of the three ways this can fail", () => {
  const state = (o: Parameters<typeof pushStateOf>[0]) => pushStateOf(o);

  it("tells an unsupported browser from a blocked one from an unregistered one", async () => {
    expect(state({ supported: false, permission: "granted", subscribed: false })).toBe("unsupported");
    expect(state({ supported: true, permission: "denied", subscribed: false })).toBe("blocked");
    expect(state({ supported: true, permission: "default", subscribed: false })).toBe("off");
    expect(state({ supported: true, permission: "granted", subscribed: true })).toBe("on");
  });

  it("says 'on' for a subscribed device whose permission reads default", async () => {
    // A browser can report "default" while a live subscription exists —
    // permission is per-origin and can be reset without the subscription being
    // torn down. Showing "off" there is the one wrong answer that has somebody
    // turn it on twice and get two of every alert.
    expect(state({ supported: true, permission: "default", subscribed: true })).toBe("on");
    expect(state({ supported: true, permission: "denied", subscribed: true })).toBe("on");
  });

  it("offers a button only where pressing one could do something", async () => {
    // The browser will not ask again once denied, and an unsupported browser
    // never could. A button that silently does nothing is worse than none.
    expect(pushCopy("on").action).toBeTruthy();
    expect(pushCopy("off").action).toBeTruthy();
    expect(pushCopy("blocked").action).toBeNull();
    expect(pushCopy("unsupported").action).toBeNull();
    expect(pushCopy("needs-install").action).toBeNull();
    // And each says something different, so the row is never ambiguous.
    const all: PushState[] = ["on", "off", "blocked", "unsupported", "needs-install"];
    const subs = all.map((s) => pushCopy(s).sub);
    expect(new Set(subs).size).toBe(all.length);
    // None of them is empty, which is what a missing switch arm would produce.
    for (const s of subs) expect(s.length).toBeGreaterThan(10);
    // Blocked has to say where the switch actually is, since it is not here.
    expect(pushCopy("blocked").sub).toContain("browser");
  });
});

describe("an iPhone in a browser tab", () => {
  // This is most of the phones this companion is for, and it was being told
  // something false. Safari has had Web Push since 16.4 — but only for a site
  // added to the Home Screen. In a tab, `window.PushManager` does not exist,
  // which is indistinguishable from "this browser cannot" unless you look at
  // what the browser actually is.

  it("is not confused with a Mac, even when it says it is one", async () => {
    expect(isApplePortable(IPHONE, 5)).toBe(true);
    // An iPad reports a desktop Safari string. A touchscreen gives it away;
    // a real Mac reports zero touch points.
    expect(isApplePortable(IPAD, 5)).toBe(true);
    expect(isApplePortable(MAC, 0)).toBe(false);
    expect(isApplePortable("Mozilla/5.0 (Linux; Android 14) Mobile", 5)).toBe(false);
  });

  it("is told to add it to the Home Screen, not that its browser cannot", async () => {
    const { env } = fakeEnv({ hasPushManager: false, ua: IPHONE, maxTouchPoints: 5, standalone: false });
    expect(await currentPushState(env)).toBe("needs-install");
    const r = await enablePush(env);
    expect(r.state).toBe("needs-install");
    // And the row names the actual gesture, since the button cannot be here.
    expect(pushCopy("needs-install").sub).toContain("Home Screen");
    expect(pushCopy("needs-install").action).toBeNull();
    expect(pushCopy("needs-install").sub).not.toBe(pushCopy("unsupported").sub);
  });

  it("does not tell an installed app to install itself", async () => {
    // Standalone and still no PushManager is an iOS older than 16.4. Nothing
    // the user does to the Home Screen will change that, so saying so would
    // send them round a loop.
    const { env } = fakeEnv({ hasPushManager: false, ua: IPHONE, maxTouchPoints: 5, standalone: true });
    expect(await currentPushState(env)).toBe("unsupported");
  });

  it("does not tell a working browser to install anything", async () => {
    // The question only arises when push is missing. An installed PWA that has
    // it must never be sent to the share sheet.
    expect(needsHomeScreen({ hasPushManager: true, ua: IPHONE, maxTouchPoints: 5, standalone: false })).toBe(false);
  });

  it("leaves a desktop browser without push saying exactly that", async () => {
    // A Mac or a Linux desktop on an old browser has nothing to add to a home
    // screen, and telling it to would be nonsense.
    const { env } = fakeEnv({ hasPushManager: false, ua: MAC, maxTouchPoints: 0 });
    expect(await currentPushState(env)).toBe("unsupported");
  });
});

describe("naming the device", () => {
  it("does not call an iPad a Mac, or an Android a Linux box", async () => {
    // Order matters in both cases: iPadOS reports "Macintosh", and every
    // Android browser string also contains "Linux".
    expect(deviceLabel("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Macintosh")).toBe("iPad");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile")).toBe("Android phone");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; SM-X200)")).toBe("Android tablet");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64)")).toBe("Windows PC");
    expect(deviceLabel("")).toBe("This device");
  });

  it("sends the name to the server, so the device list is readable", async () => {
    const { env, calls } = fakeEnv({ permission: "granted" });
    await enablePush(env);
    expect(calls.toldServer[0]!.label).toBe("Android phone");
  });
});

describe("turning it on", () => {
  it("asks for permission before subscribing, because the other order always fails", async () => {
    // `subscribe()` fails outright unless permission is already granted, so a
    // flow that subscribed first would fail on every phone, every time.
    const { env, calls } = fakeEnv();
    const r = await enablePush(env);
    expect(r.ok).toBe(true);
    expect(r.state).toBe("on");
    expect(calls.permissionAsked).toBe(1);
    expect(calls.subscribedWith).toHaveLength(1);
  });

  it("does not re-ask when permission was already granted", async () => {
    const { env, calls } = fakeEnv({ permission: "granted" });
    await enablePush(env);
    expect(calls.permissionAsked).toBe(0);
  });

  it("stops at a denied permission and says who can undo it", async () => {
    const { env, calls } = fakeEnv({ requestPermission: async () => "denied" });
    const r = await enablePush(env);
    expect(r.ok).toBe(false);
    expect(r.state).toBe("blocked");
    expect(r.error).toContain("browser settings");
    expect(calls.subscribedWith).toHaveLength(0);
    expect(calls.toldServer).toHaveLength(0);
  });

  it("stops at a dismissed prompt without calling it blocked", async () => {
    // "default" is the user swiping the prompt away. They can be asked again;
    // "denied" means they cannot. Conflating the two hides a working button.
    const { env } = fakeEnv({ requestPermission: async () => "default" });
    const r = await enablePush(env);
    expect(r.ok).toBe(false);
    expect(r.state).toBe("off");
  });

  it("refuses to subscribe against a key the server did not give", async () => {
    // Subscribing against the wrong key mints a subscription this server can
    // never send to — the push service rejects its token — while the phone
    // shows a perfectly healthy "on".
    const { env, calls } = fakeEnv({ permission: "granted", getKey: async () => ({ key: "" }) });
    const r = await enablePush(env);
    expect(r.ok).toBe(false);
    expect(calls.subscribedWith).toHaveLength(0);
  });

  it("reuses a subscription the browser already has", async () => {
    // It may have been made against this same key and simply not be known to
    // the server — a restored config, or a server that lost its file. Minting
    // a second one gives one phone two endpoints and two of every alert.
    const { env, calls } = fakeEnv({ permission: "granted", existing: { endpoint: "https://push.example/old" } });
    const r = await enablePush(env);
    expect(r.ok).toBe(true);
    expect(calls.subscribedWith).toHaveLength(0);
    expect(calls.toldServer[0]!.sub).toMatchObject({ endpoint: "https://push.example/old" });
  });

  it("asks for userVisibleOnly, which the browser enforces anyway", async () => {
    // A browser revokes a subscription that receives pushes and shows nothing.
    const { env, calls } = fakeEnv({ permission: "granted" });
    await enablePush(env);
    expect(calls.subscribedWith[0]!.userVisibleOnly).toBe(true);
  });

  it("does not claim success when the server would not take it", async () => {
    const { env } = fakeEnv({ permission: "granted", serverTakesIt: { ok: false, error: "no room" } });
    const r = await enablePush(env);
    expect(r.ok).toBe(false);
    expect(r.state).toBe("off");
    expect(r.error).toContain("no room");
  });

  it("answers rather than throwing when the browser refuses mid-flow", async () => {
    // This runs from a tap in a settings sheet. An exception here would take
    // the sheet — and on a phone, that is the whole screen.
    const { env } = fakeEnv({ permission: "granted", subscribeThrows: "AbortError: registration failed" });
    const r = await enablePush(env);
    expect(r.ok).toBe(false);
    expect(String(r.ok === false && r.error)).toContain("AbortError");
  });

  it("gives up on a subscribe that never comes back", async () => {
    // Found in a real browser, not reasoned about: with no reachable push
    // service `subscribe()` does not fail, it waits — minutes, silently — and
    // the settings toggle sat on "…" forever. Not on, not off, and not saying
    // so is the worst of the three.
    const { env, calls } = fakeEnv({
      permission: "granted",
      timeoutMs: 5,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    });
    env.sw!.ready = Promise.resolve({
      pushManager: {
        getSubscription: async () => null,
        subscribe: () => new Promise(() => { /* never */ }),
      },
    } as never);
    const r = await enablePush(env);
    expect(r.ok).toBe(false);
    expect(r.state).toBe("off");
    expect(String(r.ok === false && r.error)).toContain("could not be reached");
    // And it never told the server about a subscription it does not have.
    expect(calls.toldServer).toHaveLength(0);
  });

  it("does not fail a subscribe that lands just inside the bound", async () => {
    // A slow phone on a slow network is the normal case this feature exists
    // for. A timeout that fires on merely-slow would make it unusable there.
    const { env } = fakeEnv({ permission: "granted", timeoutMs: 50 });
    const slow = env.sw!.ready;
    env.sw!.ready = Promise.resolve({
      pushManager: {
        getSubscription: async () => null,
        subscribe: async (o: unknown) => {
          await new Promise((r) => setTimeout(r, 10));
          return (await slow).pushManager.subscribe(o as never);
        },
      },
    } as never);
    const r = await enablePush(env);
    expect(r.ok).toBe(true);
    expect(r.state).toBe("on");
  });

  it("says so plainly on a browser that cannot do this at all", async () => {
    const { env, calls } = fakeEnv({ hasPushManager: false });
    const r = await enablePush(env);
    expect(r.state).toBe("unsupported");
    expect(calls.permissionAsked).toBe(0);
  });
});

describe("turning it off", () => {
  it("tells the server before it tells the browser", async () => {
    // The other order leaves this machine pushing to an endpoint the browser
    // has already dropped, until the push service eventually answers 410 —
    // silently, while the phone is still listed as a device it no longer is.
    const { env, calls } = fakeEnv({ existing: { endpoint: "https://push.example/old" } });
    const r = await disablePush(env);
    expect(r.ok).toBe(true);
    expect(r.state).toBe("off");
    expect(calls.order).toEqual(["server-unsubscribe", "browser-unsubscribe"]);
    expect(calls.toldServerToForget).toEqual(["https://push.example/old"]);
  });

  it("is not an error when there was nothing subscribed", async () => {
    const { env, calls } = fakeEnv({ existing: null });
    const r = await disablePush(env);
    expect(r.ok).toBe(true);
    expect(r.state).toBe("off");
    expect(calls.toldServerToForget).toEqual([]);
  });

  it("stays on when it could not be turned off", async () => {
    // Reporting "off" for a device that is still subscribed would leave the
    // row lying, and the next alert would arrive on a phone told it wouldn't.
    const { env } = fakeEnv({
      existing: { endpoint: "https://push.example/old" },
      unsubscribe: async () => { throw new Error("server unreachable"); },
    });
    const r = await disablePush(env);
    expect(r.ok).toBe(false);
    expect(r.state).toBe("on");
  });
});

describe("working out where this device stands", () => {
  it("registers the worker while it looks", async () => {
    // Registering an unchanged file is a no-op, so doing it here is what makes
    // the worker receiving the next push the one that shipped, rather than one
    // left over from an older build.
    const { env, calls } = fakeEnv({ permission: "granted", existing: { endpoint: "e" } });
    expect(await currentPushState(env)).toBe("on");
    expect(calls.registered).toEqual(["./sw.js"]);
  });

  it("registers relative to the app, not to the host root", async () => {
    // The demo build is served from a sub-path. An absolute "/sw.js" would
    // 404 there and take the scope with it.
    const { env, calls } = fakeEnv({ permission: "granted" });
    await currentPushState(env);
    expect(calls.registered[0]!.startsWith("/")).toBe(false);
  });

  it("reports unsupported when the worker will not register", async () => {
    // No worker means no push, whatever the browser claims to support.
    const { env } = fakeEnv({ registerThrows: true });
    expect(await currentPushState(env)).toBe("unsupported");
  });

  it("reports unsupported with no service worker at all", async () => {
    const { env } = fakeEnv({ sw: null });
    expect(await currentPushState(env)).toBe("unsupported");
  });
});
