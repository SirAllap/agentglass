/*
 * An agent's settings request is deleted by the server before it is applied, so a refused Approve
 * (409: the setting changed since) used to leave a card that vanished with no word, and it read as
 * applied. The refusal must outlive the card; a refusal with the card still there stays on the card.
 */
import { describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";

const stub = globalStubs();
let pending: { id: string; setting: string; who: string; diff: string[]; expires: number }[] = [];
let decide: { status: number; body: unknown; removes: boolean } = { status: 200, body: { ok: true }, removes: true };
stub("fetch", async (url: string) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "");
  if (path.startsWith("/settings/requests/decide")) {
    if (decide.removes) pending = [];
    return new Response(JSON.stringify(decide.body), { status: decide.status, headers: { "content-type": "application/json" } });
  }
  if (path.startsWith("/settings/requests")) return Response.json({ ok: true, requests: pending });
  return Response.json({ ok: true });
});

const { answerSettingsRequest, settingsRefusals, settingsRequestsChanged, settingsRequests } = await import("../src/lib/settingsRequests.ts");
const req = { id: "sr_1", setting: "workers.roles", who: "an unnamed agent", diff: ["Worker roles"], expires: Date.now() + 60_000 };
const about = { who: req.who, title: "Worker roles" };

describe("a refused answer is not lost with its card", () => {
  test("Approve refused after the request left the list: the refusal is kept, with the server's words", async () => {
    pending = [req]; await settingsRequestsChanged();
    expect(settingsRequests.list().length).toBe(1);
    decide = { status: 409, body: { ok: false, error: "worker roles are global; nothing was applied" }, removes: true };
    const err = await answerSettingsRequest(req.id, true, about);
    expect(err).toBe("worker roles are global; nothing was applied");
    expect(settingsRequests.list().length).toBe(0);
    expect(settingsRefusals.list()).toEqual([{ id: "sr_1", ...about, approve: true, error: "worker roles are global; nothing was applied" }]);
    settingsRefusals.dismiss("sr_1");
    expect(settingsRefusals.list()).toEqual([]);
  });

  test("an Approve that applied leaves no refusal", async () => {
    pending = [req]; await settingsRequestsChanged();
    decide = { status: 200, body: { ok: true, applied: true }, removes: true };
    expect(await answerSettingsRequest(req.id, true, about)).toBeNull();
    expect(settingsRefusals.list()).toEqual([]);
  });

  test("a refusal while the card is still listed stays on the card, not in the store", async () => {
    pending = [req]; await settingsRequestsChanged();
    decide = { status: 500, body: { ok: false, error: "try again" }, removes: false };
    expect(await answerSettingsRequest(req.id, true, about)).toBe("try again");
    expect(settingsRefusals.list()).toEqual([]);
  });

  test("the server not answering at all after the card left is also kept", async () => {
    pending = [req]; await settingsRequestsChanged();
    decide = { status: 200, body: "not json", removes: true };
    const err = await answerSettingsRequest(req.id, false, about);
    expect(err).not.toBeNull();
    expect(settingsRefusals.list()[0]?.approve).toBe(false);
    settingsRefusals.dismiss("sr_1");
  });
});

describe("the chip and the list draw it", () => {
  test("the chip stays up while a refusal waits, and the list renders a card for it", async () => {
    const chip = await Bun.file(new URL("../src/components/AgentChangeChip.tsx", import.meta.url)).text();
    expect(chip).toContain("!refused.length");
    const list = await Bun.file(new URL("../src/components/SettingsRequests.tsx", import.meta.url)).text();
    expect(list).toContain("refused.map((x) => <RefusalCard");
    expect(list).toContain('role="alert"');
  });
});
