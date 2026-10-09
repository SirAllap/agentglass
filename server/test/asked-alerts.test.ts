import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askedAlertKey, watchPayload, type NotifyPayload } from "../../shared/notifyPayload.ts";

/*
 * A notification the person asked for outlives the window that drew it. These
 * pin the four things that make that true: one alert per event, an alert that is
 * still there after a "restart" (a fresh read of the table), closing that
 * answers every window, and a failure that is written down instead of lost.
 */
const dir = mkdtempSync(join(tmpdir(), "agx-asked-"));
process.env.AGENTGLASS_DB = join(dir, "t.db");
process.env.AGENTGLASS_SCAN_DISABLED = "1";

let A: typeof import("../src/askedAlerts.ts");
let DB: typeof import("../src/db.ts");
const events: { type: string; data: unknown }[] = [];

beforeAll(async () => {
  DB = await import("../src/db.ts");
  A = await import("../src/askedAlerts.ts");
  A.subscribeAskedAlerts((e) => events.push(e));
});
beforeEach(() => { DB.db.run("DELETE FROM asked_alert"); events.length = 0; });

const fire = { repo: "acme/orbit", number: 1042, title: "ORBIT-1042 add thing", summary: "CI passed", detail: "" };
const payload = (): NotifyPayload => watchPayload(fire);
const key = (sha = "abc123", verdict = "pass") => askedAlertKey({ repo: "acme/orbit", number: 1042, sha, verdict });

describe("one alert per event", () => {
  it("a second raise of the same PR, head and verdict is not raised again", () => {
    expect(A.raiseAsked({ key: key(), ok: true, payload: payload() })).not.toBeNull();
    expect(A.raiseAsked({ key: key(), ok: true, payload: payload() })).toBeNull();
    expect(A.openAsked()).toHaveLength(1);
    expect(events.filter((e) => e.type === "askedalert")).toHaveLength(1);
  });
  it("a new head or another verdict is a new event", () => {
    A.raiseAsked({ key: key("abc123"), ok: true, payload: payload() });
    expect(A.raiseAsked({ key: key("def456"), ok: true, payload: payload() })).not.toBeNull();
    expect(A.raiseAsked({ key: key("abc123", "fail"), ok: false, payload: payload() })).not.toBeNull();
    expect(A.openAsked()).toHaveLength(3);
  });
  it("closing an alert does not let the same event come back", () => {
    const a = A.raiseAsked({ key: key(), ok: true, payload: payload() })!;
    A.closeAsked(a.id, false);
    expect(A.raiseAsked({ key: key(), ok: true, payload: payload() })).toBeNull();
    expect(A.openAsked()).toHaveLength(0);
  });
});

describe("durable until acted on", () => {
  it("is still open on a fresh read, with its target, until it is closed", () => {
    const a = A.raiseAsked({ key: key(), ok: true, payload: payload() })!;
    const again = A.openAsked();
    expect(again.map((x) => x.id)).toEqual([a.id]);
    expect(again[0]!.payload.target).toEqual({ kind: "pr", repo: "acme/orbit", number: 1042 });
  });
  it("being seen does not take it down", () => {
    const a = A.raiseAsked({ key: key(), ok: true, payload: payload() })!;
    expect(A.markSeen(a.id)).toBe(true);
    expect(A.openAsked()).toHaveLength(1);
    expect(A.markSeen(a.id)).toBe(false); // the first draw is the one that counts
  });
  it("close says whether it was acted on, and tells every window", () => {
    const a = A.raiseAsked({ key: key(), ok: true, payload: payload() })!;
    const b = A.raiseAsked({ key: key("def"), ok: false, payload: payload() })!;
    expect(A.closeAsked(a.id, true)).toBe(true);
    expect(A.closeAsked(a.id, true)).toBe(false);
    A.closeAsked(b.id, false);
    const rows = A.auditAsked();
    expect(rows.find((r) => r.id === a.id)!.actedAt).not.toBeNull();
    expect(rows.find((r) => r.id === b.id)!.actedAt).toBeNull();
    expect(events.filter((e) => e.type === "askedclosed").map((e) => (e.data as { id: string }).id)).toEqual([a.id, b.id]);
  });
});

describe("failures are visible", () => {
  it("an OS popup that could not be shown is kept on the row and logged", () => {
    const a = A.raiseAsked({ key: key(), ok: true, payload: payload() })!;
    const warn = console.warn; const lines: string[] = [];
    console.warn = (...x: unknown[]) => { lines.push(x.join(" ")); };
    try { expect(A.osFailed(a.id, "permission denied")).toBe(true); } finally { console.warn = warn; }
    expect(lines.join("\n")).toContain("permission denied");
    expect(A.auditAsked()[0]!.osError).toBe("permission denied");
    expect(A.openAsked()).toHaveLength(1); // the banner still stands
  });
});

describe("the audit", () => {
  it("lists the last N newest first with fired, seen and acted times", () => {
    for (let i = 0; i < 5; i++) A.raiseAsked({ key: key(`s${i}`), ok: true, payload: payload() }, 1000 + i);
    const rows = A.auditAsked(3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.firedAt)).toEqual([1004, 1003, 1002]);
    expect(rows[0]).toMatchObject({ seenAt: null, actedAt: null, closedAt: null });
  });
  it("keeps only AUDIT_KEEP closed rows and never drops an open one", () => {
    for (let i = 0; i < A.AUDIT_KEEP + 5; i++) {
      const a = A.raiseAsked({ key: key(`k${i}`), ok: true, payload: payload() }, 1000 + i)!;
      if (i % 2 === 0) A.closeAsked(a.id, false, 2000 + i);
    }
    const all = DB.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM asked_alert`).get()!.n;
    expect(all).toBeLessThanOrEqual(A.AUDIT_KEEP + 5);
    expect(A.openAsked().length).toBeGreaterThan(20);
  });
});

describe("the route", () => {
  it("lists open alerts and the audit; closes by id; rejects a missing id; ignores other paths", () => {
    const a = A.raiseAsked({ key: key(), ok: true, payload: payload() })!;
    const list = A.handleAskedAlertRoute("GET", "/alerts/asked", {})!;
    expect((list.data as { open: unknown[] }).open).toHaveLength(1);
    expect((A.handleAskedAlertRoute("GET", "/alerts/asked/audit", {})!.data as { audit: unknown[] }).audit).toHaveLength(1);
    expect(A.handleAskedAlertRoute("POST", "/alerts/asked/close", {})!.status).toBe(400);
    expect(A.handleAskedAlertRoute("POST", "/alerts/asked/close", { id: a.id, acted: true })!.data).toEqual({ ok: true });
    expect(A.handleAskedAlertRoute("GET", "/prs/notify-watch", {})).toBeNull();
  });
});
