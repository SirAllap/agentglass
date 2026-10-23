/*
 * The list of computers this phone is paired to (src/lib/hosts.ts), and the
 * single-record API (src/lib/host.ts) that is now a view of its active entry.
 *
 * The keystore is a Map here, injected through `__useKeystore` and not
 * `mock.module`, which is process-wide and clobbers talk-pref.test.ts. It has
 * switches to make a read or a write throw: the cases that matter are the ones
 * where the keystore misbehaves in the middle of a migration, because losing a
 * token there means walking back to the computer to pair again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
const fault = { write: null as string | null, read: false };

const fake = {
  WHEN_UNLOCKED: 1,
  getItemAsync: async (key: string) => {
    if (fault.read) throw new Error("keystore will not open");
    return store.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (fault.write === key) throw new Error("keystore full");
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => { store.delete(key); },
};

let hosts: typeof import("../src/lib/hosts.ts");
let host: typeof import("../src/lib/host.ts");

beforeAll(async () => {
  hosts = await import("../src/lib/hosts.ts");
  host = await import("../src/lib/host.ts");
  hosts.__useKeystore(fake);
});

afterAll(() => hosts.__useKeystore(null));

const OLD = "agentglass.host";
const NEW = "agentglass.hosts";

const rec = (n: number) => ({
  origin: `http://192.168.1.${n}:4000`,
  token: `token-${n}`,
  label: `Phone ${n}`,
  scope: "answer" as const,
  pairedAt: 1000 + n,
});

beforeEach(() => {
  store.clear();
  fault.write = null;
  fault.read = false;
});

describe("migrating the single stored record", () => {
  test("wraps it as the one active computer and keeps the token", async () => {
    store.set(OLD, JSON.stringify(rec(1)));
    const list = await hosts.loadHosts();
    expect(list.hosts.length).toBe(1);
    expect(list.hosts[0]!.token).toBe("token-1");
    expect(list.hosts[0]!.origin).toBe("http://192.168.1.1:4000");
    expect(list.active).toBe(list.hosts[0]!.id);
    expect(list.hosts[0]!.id.length).toBeGreaterThan(5);
  });

  test("writes the new key, then deletes the old one", async () => {
    store.set(OLD, JSON.stringify(rec(1)));
    await hosts.loadHosts();
    expect(store.has(OLD)).toBe(false);
    const saved = JSON.parse(store.get(NEW)!);
    expect(saved.v).toBe(1);
    expect(saved.hosts[0].token).toBe("token-1");
  });

  test("a failed write leaves the old key where it was", async () => {
    // Broken on purpose: deleting the old key before the new one reads back is
    // exactly how a full keystore turns an upgrade into a re-pair.
    store.set(OLD, JSON.stringify(rec(1)));
    fault.write = NEW;
    const list = await hosts.loadHosts();
    expect(store.has(OLD)).toBe(true);
    expect(store.has(NEW)).toBe(false);
    // The app still opens on the computer it knew.
    expect(list.hosts[0]!.token).toBe("token-1");
  });

  test("is idempotent: a second load changes nothing, ids included", async () => {
    store.set(OLD, JSON.stringify(rec(1)));
    const first = await hosts.loadHosts();
    const raw = store.get(NEW);
    const second = await hosts.loadHosts();
    expect(second).toEqual(first);
    expect(store.get(NEW)).toBe(raw);
  });

  test("a crash between the write and the delete finishes on the next load", async () => {
    store.set(OLD, JSON.stringify(rec(1)));
    await hosts.loadHosts();
    store.set(OLD, JSON.stringify(rec(1))); // the delete that never happened
    const again = await hosts.loadHosts();
    expect(again.hosts.length).toBe(1);
    expect(store.has(OLD)).toBe(false);
  });

  test("the new key wins when both exist", async () => {
    store.set(OLD, JSON.stringify(rec(9)));
    await hosts.addHost(rec(1)); // migrates 9, adds 1
    store.set(OLD, JSON.stringify(rec(9)));
    const list = await hosts.loadHosts();
    expect(list.hosts.map((h) => h.token).sort()).toEqual(["token-1", "token-9"]);
  });
});

describe("a keystore that cannot be trusted", () => {
  test("unreadable JSON is an empty list, not a throw", async () => {
    store.set(NEW, "{not json");
    const list = await hosts.loadHosts();
    expect(list).toEqual({ active: null, hosts: [] });
  });

  test("a keystore that will not open is an empty list", async () => {
    fault.read = true;
    expect(await hosts.loadHosts()).toEqual({ active: null, hosts: [] });
  });

  test("an entry without an address or a token is dropped, the rest kept", async () => {
    store.set(NEW, JSON.stringify({
      v: 1, active: "b",
      hosts: [
        { id: "a", origin: "", token: "x", label: "L", scope: "answer", pairedAt: 1, lastUsed: 1 },
        { id: "b", origin: "http://10.0.0.2:4000", token: "y", label: "L", scope: "answer", pairedAt: 1, lastUsed: 2 },
      ],
    }));
    const list = await hosts.loadHosts();
    expect(list.hosts.map((h) => h.id)).toEqual(["b"]);
    expect(list.active).toBe("b");
  });

  test("an active id that points at nothing falls back to the most recent", async () => {
    store.set(NEW, JSON.stringify({
      v: 1, active: "gone",
      hosts: [
        { id: "a", origin: "http://10.0.0.1:4000", token: "x", label: "L", scope: "answer", pairedAt: 1, lastUsed: 5 },
        { id: "b", origin: "http://10.0.0.2:4000", token: "y", label: "L", scope: "answer", pairedAt: 1, lastUsed: 9 },
      ],
    }));
    expect((await hosts.loadHosts()).active).toBe("b");
  });

  test("a failed write on add leaves the stored list as it was", async () => {
    await hosts.addHost(rec(1));
    const before = store.get(NEW);
    fault.write = NEW;
    await expect(hosts.addHost(rec(2))).rejects.toThrow();
    expect(store.get(NEW)).toBe(before);
  });
});

describe("adding, replacing, switching, forgetting", () => {
  test("the first computer added is active", async () => {
    const list = await hosts.addHost(rec(1));
    expect(list.active).toBe(list.hosts[0]!.id);
  });

  test("a new computer becomes active and is listed most recent first", async () => {
    await hosts.addHost(rec(1));
    const list = await hosts.addHost(rec(2));
    expect(list.hosts.map((h) => h.token)).toEqual(["token-2", "token-1"]);
    expect(list.hosts.find((h) => h.id === list.active)!.token).toBe("token-2");
  });

  test("pairing the same address again replaces its key and keeps its id and name", async () => {
    const first = await hosts.addHost(rec(1));
    const id = first.hosts[0]!.id;
    await hosts.renameHost(id, "Studio");
    await hosts.addHost(rec(2));
    const list = await hosts.addHost({ ...rec(1), token: "fresh" });
    expect(list.hosts.length).toBe(2);
    const again = list.hosts.find((h) => h.id === id)!;
    expect(again.token).toBe("fresh");
    expect(again.name).toBe("Studio");
    expect(list.active).toBe(id);
  });

  test("the same address in another spelling is the same computer", async () => {
    await hosts.addHost(rec(1));
    const list = await hosts.addHost({ ...rec(1), origin: "HTTP://192.168.1.1:4000/", token: "fresh" });
    expect(list.hosts.length).toBe(1);
    expect(list.hosts[0]!.token).toBe("fresh");
  });

  test("five computers fit and a sixth is refused, without touching the list", async () => {
    for (let n = 1; n <= hosts.MAX_HOSTS; n++) await hosts.addHost(rec(n));
    const before = store.get(NEW);
    await expect(hosts.addHost(rec(6))).rejects.toThrow(/5/);
    expect(store.get(NEW)).toBe(before);
    // Pairing one it already has is not a sixth.
    const list = await hosts.addHost({ ...rec(3), token: "again" });
    expect(list.hosts.length).toBe(5);
  });

  test("switching makes it active and most recent", async () => {
    const a = (await hosts.addHost(rec(1))).hosts[0]!.id;
    await hosts.addHost(rec(2));
    const list = await hosts.setActive(a);
    expect(list.active).toBe(a);
    expect(list.hosts[0]!.id).toBe(a);
  });

  test("switching twice inside one millisecond still orders them", async () => {
    const a = (await hosts.addHost(rec(1))).hosts[0]!.id;
    const b = (await hosts.addHost(rec(2))).hosts.find((h) => h.token === "token-2")!.id;
    const realNow = Date.now;
    Date.now = () => 5_000_000;
    try {
      await hosts.setActive(a);
      const list = await hosts.setActive(b);
      expect(list.hosts.map((h) => h.id)).toEqual([b, a]);
    } finally {
      Date.now = realNow;
    }
  });

  test("switching to an id that is not there changes nothing", async () => {
    await hosts.addHost(rec(1));
    const before = store.get(NEW);
    const list = await hosts.setActive("nope");
    expect(list.active).toBe((await hosts.loadHosts()).active);
    expect(store.get(NEW)).toBe(before);
  });

  test("renaming keeps the name, and an empty name clears it", async () => {
    const id = (await hosts.addHost(rec(1))).hosts[0]!.id;
    expect((await hosts.renameHost(id, "  Desk  ")).hosts[0]!.name).toBe("Desk");
    expect((await hosts.renameHost(id, "   ")).hosts[0]!.name).toBeUndefined();
  });

  test("forgetting the active one selects the next most recent", async () => {
    const a = (await hosts.addHost(rec(1))).hosts[0]!.id;
    await hosts.addHost(rec(2));
    const c = (await hosts.addHost(rec(3))).active!;
    await hosts.setActive(a); // order now: a, 3, 2
    const list = await hosts.removeHost(a);
    expect(list.hosts.length).toBe(2);
    expect(list.active).toBe(c);
  });

  test("forgetting one that is not active leaves the active one alone", async () => {
    const a = (await hosts.addHost(rec(1))).hosts[0]!.id;
    const b = (await hosts.addHost(rec(2))).active!;
    const list = await hosts.removeHost(a);
    expect(list.active).toBe(b);
    expect(list.hosts.length).toBe(1);
  });

  test("forgetting the last one leaves nothing active", async () => {
    const a = (await hosts.addHost(rec(1))).hosts[0]!.id;
    expect(await hosts.removeHost(a)).toEqual({ active: null, hosts: [] });
  });

  test("two changes started together both land", async () => {
    // Broken on purpose: read-modify-write with no queue loses one of two
    // overlapping calls, and the one lost can be the add of a token.
    const [, , list] = await Promise.all([
      hosts.addHost(rec(1)),
      hosts.addHost(rec(2)),
      hosts.addHost(rec(3)),
    ]);
    expect(list.hosts.length).toBe(3);
    expect((await hosts.loadHosts()).hosts.length).toBe(3);
  });
});

describe("a computer that took this phone off its list", () => {
  test("is marked, not dropped, and the others keep working", async () => {
    // Broken on purpose: forgetting on a 401 loses the entry, and with it the
    // "Removed at the computer" row that says what happened.
    const a = (await hosts.addHost(rec(1))).hosts[0]!.id;
    await hosts.addHost(rec(2));
    const list = await hosts.markRevoked(a);
    expect(list.hosts.length).toBe(2);
    expect(list.hosts.find((h) => h.id === a)!.revoked).toBeGreaterThan(0);
    expect(list.hosts.find((h) => h.id !== a)!.revoked).toBeUndefined();
  });

  test("is still there after a reload", async () => {
    const a = (await hosts.addHost(rec(1))).hosts[0]!.id;
    await hosts.markRevoked(a);
    expect((await hosts.loadHosts()).hosts[0]!.revoked).toBeGreaterThan(0);
  });

  test("pairing it again clears the mark and keeps the entry", async () => {
    const a = (await hosts.addHost(rec(1))).hosts[0]!.id;
    await hosts.markRevoked(a);
    const list = await hosts.addHost({ ...rec(1), token: "fresh" });
    expect(list.hosts.length).toBe(1);
    expect(list.hosts[0]!.id).toBe(a);
    expect(list.hosts[0]!.revoked).toBeUndefined();
  });

  test("marking one that is gone, or already marked, writes nothing", async () => {
    const a = (await hosts.addHost(rec(1))).hosts[0]!.id;
    await hosts.markRevoked(a);
    const before = store.get(NEW);
    await hosts.markRevoked(a);
    await hosts.markRevoked("nope");
    expect(store.get(NEW)).toBe(before);
  });
});

describe("host.ts, the single-record view the rest of the app still calls", () => {
  test("loadHost is the active computer, with its id", async () => {
    await hosts.addHost(rec(1));
    await hosts.addHost(rec(2));
    const h = await host.loadHost();
    expect(h!.token).toBe("token-2");
    expect(typeof h!.id).toBe("string");
  });

  test("loadHost on an old install migrates and returns the record", async () => {
    store.set(OLD, JSON.stringify(rec(1)));
    expect((await host.loadHost())!.token).toBe("token-1");
    expect(store.has(OLD)).toBe(false);
  });

  test("loadHost is null when nothing is paired", async () => {
    expect(await host.loadHost()).toBeNull();
  });

  test("saveHost adds and activates; forgetHost drops the active one only", async () => {
    await host.saveHost(rec(1));
    await host.saveHost(rec(2));
    await host.forgetHost();
    expect((await host.loadHost())!.token).toBe("token-1");
    await host.forgetHost();
    expect(await host.loadHost()).toBeNull();
  });
});
