/*
 * What the first run says about its own window.
 *
 * The port strip exists only when the shell moved off the port it asked for,
 * and names both numbers without guessing who took the other one. The display
 * line is X11's alone. Both are read from facts, never from the shell's log.
 */
import { describe, expect, it } from "bun:test";
import {
  apiPortOf,
  APP_PORT,
  dismissPortNotice,
  displayLine,
  noticePorts,
  PORT_DISMISSED_KEY,
  portNotice,
  portNoticeText,
  readDismissedPort,
  type ShellNoticeFacts,
} from "../src/lib/setupNotices.ts";

const shell = (over: Partial<ShellNoticeFacts & { desktop: boolean }> = {}) => ({
  desktop: true,
  preferredPort: 4000,
  serverPort: 4012,
  displayServer: "x11" as const,
  ...over,
});

describe("noticePorts", () => {
  it("takes the shell's two numbers when it has them", () => {
    expect(noticePorts(shell(), 5050)).toEqual({ preferredPort: 4000, port: 4012 });
  });

  it("a browser tab the server served uses the page's port and the app's own", () => {
    expect(noticePorts({ desktop: false, preferredPort: null, serverPort: null, displayServer: null }, 4012))
      .toEqual({ preferredPort: APP_PORT, port: 4012 });
  });

  it("an older shell with no preferred port does not guess", () => {
    expect(noticePorts(shell({ preferredPort: null }), 4012)).toBeNull();
  });

  it("no port anywhere is no strip", () => {
    expect(noticePorts(shell({ serverPort: null }), null)).toBeNull();
  });
});

describe("portNotice", () => {
  it("appears when the window is not on the port it asked for", () => {
    expect(portNotice({ preferredPort: 4000, port: 4012 }, null))
      .toEqual({ preferredPort: 4000, port: 4012, dismissValue: "4012" });
  });

  it("is absent when the two numbers are the same", () => {
    expect(portNotice({ preferredPort: 4000, port: 4000 }, null)).toBeNull();
  });

  it("is absent once this port was dismissed", () => {
    expect(portNotice({ preferredPort: 4000, port: 4012 }, "4012")).toBeNull();
  });

  it("a dismissal of another port does not hide this one", () => {
    expect(portNotice({ preferredPort: 4000, port: 4013 }, "4012")).not.toBeNull();
  });
});

describe("the words", () => {
  it("name both numbers, what follows the server and what does not", () => {
    const words = portNoticeText({ preferredPort: 4000, port: 4012, dismissValue: "4012" });
    expect(words.title).toContain("4012");
    expect(words.title).toContain("4000");
    expect(words.body).toContain("4000");
    expect(words.body.toLowerCase()).toContain("hooks");
    expect(words.body.toLowerCase()).toContain("shell");
  });

  it("never claim another agentglass holds the other port", () => {
    const words = portNoticeText({ preferredPort: 4000, port: 4012, dismissValue: "4012" });
    expect(`${words.title} ${words.body}`.toLowerCase()).not.toContain("another agentglass");
  });
});

describe("the display line", () => {
  it("is the X11 sentence, and nothing on Wayland", () => {
    expect(displayLine("x11")).toBe("This window is drawn through X11.");
    expect(displayLine("wayland")).toBeNull();
    expect(displayLine(null)).toBeNull();
  });
});

describe("the dismissal", () => {
  it("writes this port and survives the next read", () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    expect(readDismissedPort(fake)).toBeNull();
    dismissPortNotice(4012, fake);
    expect(store.get(PORT_DISMISSED_KEY)).toBe("4012");
    expect(readDismissedPort(fake)).toBe("4012");
  });
});

describe("apiPortOf", () => {
  it("reads the port the page was served on", () => {
    expect(apiPortOf("http://127.0.0.1:4012")).toBe(4012);
    expect(apiPortOf("not a url")).toBeNull();
  });
});
