/*
 * S9: the honest identity header, `electron/identify-header.js`.
 *
 * `shouldIdentify` is what decides whether a request is going to a dev
 * origin at all; a substring check on "localhost" would have handed the
 * header to `evil-localhost.com` and `localhost.evil.com`, so those two are
 * the probes that matter here, not window dressing.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const mod: {
  IDENTIFY_HEADER: string;
  shouldIdentify: (url: string) => boolean;
  sanitizeAgentName: (name: unknown) => string | null;
  ownerAfter: (current: string | null | undefined, event: { kind: "ask"; as?: unknown } | { kind: "person" }) => string | null;
  createOwnerBook: () => {
    apply: (id: number, event: { kind: "ask"; as?: unknown } | { kind: "person" }) => void;
    get: (id: number) => string | undefined;
    drop: (id: number) => void;
  };
} = load("../../electron/identify-header.js");
const { IDENTIFY_HEADER, shouldIdentify, sanitizeAgentName, ownerAfter, createOwnerBook } = mod;

describe("shouldIdentify", () => {
  test("loopback, in every spelling it has", () => {
    for (const url of [
      "http://localhost:4000/",
      "http://LOCALHOST:4000/",
      "http://sub.localhost:4000/",
      "http://127.0.0.1:4000/",
      "http://127.255.255.255:4000/",
      "http://[::1]:4000/",
      "http://foo.test/",
      "http://test/",
    ]) expect(shouldIdentify(url), url).toBe(true);
  });

  test("a name that only contains the word, not the address", () => {
    // The exact substring bug this function exists to not have: a host that
    // is not localhost, and never was, wearing it as a name.
    for (const url of ["http://evil-localhost.com/", "http://localhost.evil.com/"]) {
      expect(shouldIdentify(url), url).toBe(false);
    }
  });

  test("a public host does not", () => {
    for (const url of ["https://example.com/", "https://api.stripe.com/v1/charges", "http://192.168.1.1/"]) {
      expect(shouldIdentify(url), url).toBe(false);
    }
  });

  test("nothing that is not a URL at all", () => {
    for (const url of ["", "not a url", "javascript:1"]) {
      expect(shouldIdentify(url), url).toBe(false);
    }
  });
});

describe("sanitizeAgentName", () => {
  test("a plain slug passes through", () => {
    expect(sanitizeAgentName("aglab3")).toBe("aglab3");
    expect(sanitizeAgentName("agx-browser-s9")).toBe("agx-browser-s9");
    expect(sanitizeAgentName("owner.aaa_1")).toBe("owner.aaa_1");
  });

  test("nothing that could inject a second header or escape the value", () => {
    for (const bad of ["evil\r\nX-Injected: 1", "has space", "semi;colon", "", "a".repeat(65), null, undefined, 42]) {
      expect(sanitizeAgentName(bad), String(bad)).toBeNull();
    }
  });
});

describe("ownerAfter: who a guest's requests are attributed to now", () => {
  const rows: Array<[string, string | null, Parameters<typeof ownerAfter>[1], string | null]> = [
    ["an ask that names itself takes an unowned tab", null, { kind: "ask", as: "orbit-bot" }, "orbit-bot"],
    ["a second agent replaces the first", "orbit-bot", { kind: "ask", as: "acme-bot" }, "acme-bot"],
    ["the same agent keeps it", "orbit-bot", { kind: "ask", as: "orbit-bot" }, "orbit-bot"],
    ["a shared ask (no `as`) clears it", "orbit-bot", { kind: "ask" }, null],
    ["an empty `as` clears it", "orbit-bot", { kind: "ask", as: "" }, null],
    ["a malformed `as` clears it, never keeps the old name", "orbit-bot", { kind: "ask", as: "a b\r\nX: 1" }, null],
    ["a non-string `as` clears it", "orbit-bot", { kind: "ask", as: 42 }, null],
    ["the person acting on the tab clears it", "orbit-bot", { kind: "person" }, null],
    ["the person on an unowned tab leaves it unowned", null, { kind: "person" }, null],
  ];
  for (const [name, current, event, want] of rows) {
    test(name, () => expect(ownerAfter(current, event)).toBe(want));
  }
});

describe("the stick: a name an agent set does not outlive that agent", () => {
  test("agent, then a shared ask, then a later ask: the guest carries nothing", () => {
    const book = createOwnerBook();
    book.apply(7, { kind: "ask", as: "orbit-bot" });
    expect(book.get(7)).toBe("orbit-bot");
    book.apply(7, { kind: "ask" });
    expect(book.get(7)).toBeUndefined();
  });

  test("agent, then the person navigating: the guest carries nothing", () => {
    const book = createOwnerBook();
    book.apply(7, { kind: "ask", as: "orbit-bot" });
    book.apply(7, { kind: "person" });
    expect(book.get(7)).toBeUndefined();
  });

  test("one guest's name never reaches another", () => {
    const book = createOwnerBook();
    book.apply(7, { kind: "ask", as: "orbit-bot" });
    book.apply(8, { kind: "person" });
    expect(book.get(7)).toBe("orbit-bot");
    expect(book.get(8)).toBeUndefined();
  });

  test("a destroyed guest is forgotten", () => {
    const book = createOwnerBook();
    book.apply(7, { kind: "ask", as: "orbit-bot" });
    book.drop(7);
    expect(book.get(7)).toBeUndefined();
  });
});

describe("the callers feed it", () => {
  const read = (rel: string) => load("node:fs").readFileSync(new URL(rel, import.meta.url), "utf8") as string;
  const noComments = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  test("every ask that addresses a guest pushes its owner, named or not", () => {
    const bus = noComments(read("../src/lib/browserBus.ts"));
    const start = bus.indexOf("export async function serveBrowserAsk(");
    expect(start).toBeGreaterThan(-1);
    const body = bus.slice(start);
    const hit = body.indexOf("setGuestOwner(");
    expect(hit).toBeGreaterThan(-1);
    // the call is not behind a `typeof ask.args.as === "string"` gate
    const before = body.slice(Math.max(0, hit - 160), hit);
    expect(before).not.toMatch(/typeof ask\.args\.as === "string"\)/);
    expect(body.slice(hit, hit + 120)).toContain('typeof ask.args.as === "string" ? ask.args.as : ""');
  });

  test("the person typing an address, or picking a tab, says so", () => {
    const panel = noComments(read("../src/components/BrowserPanel.tsx"));
    expect(panel.split('setGuestOwner(w.getWebContentsId(), "", true)').length - 1).toBe(2);
  });

  test("the shell's handler routes a person event, and nothing sets the map around ownerAfter", () => {
    const main = noComments(read("../../electron/main.js"));
    expect(main).toContain('{ kind: "person" }');
    expect(main).not.toMatch(/guestOwner\.set\(/);
    expect(main).toContain("guestOwner.drop(guest.id)");
  });
});

describe("main.js actually uses it", () => {
  const main = load("node:fs").readFileSync(
    new URL("../../electron/main.js", import.meta.url), "utf8",
  ) as string;

  test("one onBeforeSendHeaders dispatcher per session, not a second listener", () => {
    const hits = main.split(".onBeforeSendHeaders(").length - 1;
    expect(hits).toBe(1);
  });

  test("the switch is read from a map, so an untouched session stays off", () => {
    expect(main).toContain("identifyEnabled.get(");
  });

  test("the header carries a name looked up from the guest that sent the request", () => {
    expect(main).toContain("guestOwner.get(details.webContentsId)");
  });
});
