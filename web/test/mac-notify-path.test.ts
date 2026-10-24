import { describe, expect, it } from "bun:test";
import { watchPayload, alertPayload, type NotifyPayload } from "../../shared/notifyPayload.ts";
import { canRaiseInShell, popupEntries, popupPath } from "../src/lib/macNotify.ts";

/*
 * Which half raises a popup, and which buttons it may carry. UNTESTED ON A REAL
 * MAC. Names are invented (acme/orbit, ORBIT-1042).
 */
const failed = watchPayload(
  { repo: "acme/orbit", number: 1042, title: "ORBIT-1042 add thing", summary: "CI failed", detail: "build, lint", ok: false },
  { root: "/work/orbit" },
);

describe("popupPath", () => {
  it("only a Mac shell that can do it, with something to press, leaves the renderer", () => {
    expect(popupPath("darwin", true, 1)).toBe("shell");
    expect(popupPath("darwin", true, 2)).toBe("shell");
  });
  it("Linux and Windows are the renderer's, whatever the rest says", () => {
    for (const p of ["linux", "win32", undefined]) {
      expect(popupPath(p, true, 2)).toBe("renderer");
    }
  });
  it("a Mac with an older shell, or with nothing to press, is the renderer's", () => {
    expect(popupPath("darwin", false, 2)).toBe("renderer");
    expect(popupPath("darwin", true, 0)).toBe("renderer");
  });
});

describe("canRaiseInShell", () => {
  it("is false with no desktop bridge (a browser tab, a test), so the renderer's popup stays synchronous", () => {
    expect(canRaiseInShell(2)).toBe(false);
  });
});

describe("popupEntries", () => {
  it("an agent alert is one button to its pane, the same place a click goes", () => {
    const p = alertPayload({ title: "Blocked: needs Bash", body: "ls", pane: "%7" });
    const e = popupEntries(p);
    expect(e.length).toBe(1);
    expect(e[0]!.dest).toEqual({ kind: "pane", pane: "%7" });
  });
  it("a failed check keeps its trip and drops the deed: re-running writes to GitHub, and the renderer popup never ran it", () => {
    expect(failed.actions?.[1]).toMatchObject({ run: "rerun-failed" });
    const e = popupEntries(failed);
    expect(e.map((x) => x.label)).toEqual([failed.actions![0]!.label]);
    expect(e[0]!.dest).toMatchObject({ kind: "pr", repo: "acme/orbit", number: 1042 });
  });
  it("a payload with no target has no buttons", () => {
    expect(popupEntries({ title: "t", line: "l" } as NotifyPayload)).toEqual([]);
  });
  it("a link has no in-app view and a click never opened it, so it gets no button", () => {
    const p: NotifyPayload = { title: "t", line: "l", target: { kind: "url", url: "https://example.com" } };
    expect(popupEntries(p)).toEqual([]);
  });
  it("a deed first leaves nothing: the second may never become what a click does", () => {
    const p: NotifyPayload = {
      title: "t", line: "l", target: { kind: "pr", repo: "acme/orbit", number: 1042 },
      actions: [{ label: "Re-run failed", run: "rerun-failed", root: "/work/orbit", number: 1042 }, { label: "Open PR", target: { kind: "pr", repo: "acme/orbit", number: 1042 } }],
    };
    expect(popupEntries(p)).toEqual([]);
  });
});

describe("sysNotify keeps the renderer's popup byte for byte", () => {
  const SRC = Bun.file(new URL("../src/lib/sysNotify.ts", import.meta.url)).text();
  it("the Web Notification path is still there, unchanged, as the fallback", async () => {
    const s = await SRC;
    const start = s.indexOf("function popup(");
    const body = s.slice(start, s.indexOf("\n}\n", start));
    expect(body).toContain("new Notification(a.title, { body: a.body, requireInteraction: a.urgency === 2");
    expect(body).toContain("void raiseWindow();");
    expect(body).toContain("goto?.(dest);");
  });
  it("the shell is tried only when there are entries, and a refusal falls back to the renderer", async () => {
    const s = await SRC;
    const start = s.indexOf("function popup(");
    const body = s.slice(start, s.indexOf("\n}\n", start));
    expect(body).toContain("if (a.entries?.length && canRaiseInShell(a.entries.length))");
    expect(body).toContain("if (!took) popup(rest)");
    expect(body.indexOf("raiseInShell(")).toBeLessThan(body.indexOf("new Notification("));
  });
});
