/*
 * Tapping an alert used to open the app on whatever screen it was last left
 * on: nothing listened for the tap, and the data was only `{ kind: "alert" }`.
 * The decision of where a tap goes is pure and is tested here; the notify and
 * layout wiring are asserted below it.
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alertRoute } from "../src/notifications/target.ts";

describe("alertRoute", () => {
  test("an alert with a pane opens that pane in the Terminal", () => {
    expect(alertRoute({ kind: "alert", pane: "%12" })).toEqual({ pathname: "/terminal", params: { pane: "%12" } });
  });

  test("an alert with no target opens the Terminal, which lists the agents", () => {
    expect(alertRoute({ kind: "alert" })).toEqual({ pathname: "/terminal" });
  });

  test("anything that is not an alert goes nowhere", () => {
    for (const data of [undefined, null, "alert", 7, [], {}, { kind: "reminder" }, { kind: "ALERT" }, { pane: "%1" }]) {
      expect(alertRoute(data)).toBeNull();
    }
  });

  test("a pane that is not a tmux pane id is dropped, and the tap still lands on the Terminal", () => {
    const hostile = [
      "%1/../../pair", "/pair", "../x", "%", "% 1", "%1\n", "%12345678901", "1", "", "%1?x=1", "javascript:alert(1)",
      { toString: () => "%1" }, 12, ["%1"], null,
    ];
    for (const pane of hostile) {
      expect(alertRoute({ kind: "alert", pane })).toEqual({ pathname: "/terminal" });
    }
  });

  test("the route is built from constants, never from the data's own strings", () => {
    const to = alertRoute({ kind: "alert", pane: "%3", pathname: "/pair", href: "/pair" });
    expect(to?.pathname).toBe("/terminal");
    expect(Object.keys(to ?? {})).toEqual(["pathname", "params"]);
  });
});

describe("alertRoute for a watch alert", () => {
  const pr = { kind: "watch", pr: 1042, repo: "acme/orbit", root: "/home/dev/orbit" };

  test("a pull request opens its screen on its checkout", () => {
    expect(alertRoute(pr)).toEqual({ pathname: "/pr/[number]", params: { number: "1042", root: "/home/dev/orbit" } });
  });

  test("a card opens its screen", () => {
    expect(alertRoute({ kind: "watch", card: "86abc12" })).toEqual({ pathname: "/card/[id]", params: { id: "86abc12" } });
    expect(alertRoute({ kind: "watch", card: "ORBIT-1042" })).toEqual({ pathname: "/card/[id]", params: { id: "ORBIT-1042" } });
  });

  test("the summary, and a pull request with no usable checkout, open the list", () => {
    expect(alertRoute({ kind: "watch", summary: true })).toEqual({ pathname: "/prs" });
    expect(alertRoute({ kind: "watch", pr: 7 })).toEqual({ pathname: "/prs" });
    expect(alertRoute({ ...pr, root: "relative/dir" })).toEqual({ pathname: "/prs" });
  });

  test("a number that is not a whole pull request number goes nowhere", () => {
    for (const n of [0, -1, 1.5, "1042", NaN, Infinity, 1e12, null, [1042], { valueOf: () => 1 }]) {
      expect(alertRoute({ ...pr, pr: n })).toBeNull();
    }
  });

  test("a card id that could be a path or a query is refused", () => {
    for (const id of ["../pair", "/pair", "a/b", "a?x=1", "a b", "", " ", "x".repeat(65), 7, null, ["a"]]) {
      expect(alertRoute({ kind: "watch", card: id })).toBeNull();
    }
  });

  test("a root with a dot-dot, a newline, a scheme or no leading slash is not carried into the route", () => {
    for (const root of ["/a/../b", "/a\nb", "file:///etc", "javascript:1", "../x", "", 5, null, "/".padEnd(1100, "a")]) {
      expect(alertRoute({ ...pr, root })).toEqual({ pathname: "/prs" });
    }
  });

  test("the route is built from constants, never from the data's own strings", () => {
    const to = alertRoute({ ...pr, pathname: "/pair", href: "/pair", params: { number: "1" } });
    expect(to).toEqual({ pathname: "/pr/[number]", params: { number: "1042", root: "/home/dev/orbit" } });
    expect(Object.keys(to ?? {})).toEqual(["pathname", "params"]);
  });

  test("a watch alert that names nothing goes nowhere", () => {
    expect(alertRoute({ kind: "watch" })).toBeNull();
  });
});

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");

describe("the wiring", () => {
  test("the root layout routes a tap through alertRoute, and only once paired", () => {
    const layout = src("app", "_layout.tsx");
    expect(layout).toContain("watchAlertTaps(");
    expect(layout).toContain("alertRoute(data)");
    expect(layout).toContain("if (!ready || !host) return;");
  });

  test("the Terminal selects the pane an alert names", () => {
    const screen = src("app", "(tabs)", "terminal.tsx");
    expect(screen).toContain("arriving.pane");
    expect(screen).toContain("t.paneId === arriving.pane");
  });
});

mock.module("react-native", () => ({ Platform: { OS: "android" } }));
mock.module("expo-constants", () => ({
  default: { executionEnvironment: "bare" },
  ExecutionEnvironment: { StoreClient: "storeClient", Standalone: "standalone", Bare: "bare" },
}));

describe("watchAlertTaps and raise", () => {
  const response = (id: string, data: unknown) => ({ notification: { request: { identifier: id, content: { data } } } });

  test("a cold-start tap and a later tap are each handed over once; a replay is not", async () => {
    const notify = await import("../src/notifications/notify.ts");
    let listener: ((r: any) => void) | null = null;
    let removed = false;
    notify.__setNotificationsModule({
      getLastNotificationResponse: () => response("a", { kind: "alert", pane: "%2" }),
      addNotificationResponseReceivedListener: (l: (r: any) => void) => { listener = l; return { remove: () => { removed = true; } }; },
    } as any);
    const got: unknown[] = [];
    const stop = notify.watchAlertTaps((d) => got.push(d));
    listener!(response("b", { kind: "alert" }));
    listener!(response("b", { kind: "alert" }));
    expect(got).toEqual([{ kind: "alert", pane: "%2" }, { kind: "alert" }]);
    stop();
    expect(removed).toBe(true);
    notify.__setNotificationsModule(undefined);
  });

  test("without the module there is nothing to watch and nothing throws", async () => {
    const notify = await import("../src/notifications/notify.ts");
    notify.__setNotificationsModule(null);
    expect(() => notify.watchAlertTaps(() => {})()).not.toThrow();
    notify.__setNotificationsModule(undefined);
  });
});
