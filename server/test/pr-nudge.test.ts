/*
 * The nudge line says who it waits on, what for, and where — and goes down
 * the alerts' webhook only when one is configured.
 */
import { describe, expect, test } from "bun:test";
import { nudgeText, nudgeChannel, sendNudge } from "../src/prnudge.ts";

const base = { number: 42, title: "Retry the export", url: "https://example.test/pr/42", isDraft: false, reviewers: [{ login: "ana" }] as { login: string }[] };

describe("the nudge line", () => {
  test("addresses the ones waited on, and says what is asked", () => {
    const t = nudgeText({ ...base, humanReview: { kind: "awaiting", who: ["ana", "bo"] } } as never);
    expect(t).toBe('@ana @bo PR #42 "Retry the export" is waiting for your review\nhttps://example.test/pr/42');
  });
  test("after changes requested it asks for another look; after a stale approval, a re-check; a draft, a look when ready", () => {
    expect(nudgeText({ ...base, humanReview: { kind: "changes", who: ["ana"] } } as never)).toContain("has the changes you asked for");
    expect(nudgeText({ ...base, humanReview: { kind: "approved", who: ["ana"], stale: true } } as never)).toContain("has moved since your approval");
    expect(nudgeText({ ...base, isDraft: true, humanReview: undefined } as never)).toContain("is a draft still");
  });
  test("with nobody asked and nobody waited on, no @ at all", () => {
    expect(nudgeText({ ...base, reviewers: [], humanReview: undefined } as never)).toStartWith('PR #42 "Retry the export" is waiting');
  });
});

describe("the channel", () => {
  test("is the alerts' webhook, and without one the send says so rather than pretending", async () => {
    if (process.env.AGENTGLASS_WEBHOOK) return; // a configured machine is not this test's subject
    expect(nudgeChannel().configured).toBe(false);
    const r = await sendNudge("hello");
    expect(r.sent).toBe(false);
    expect(r.error).toContain("AGENTGLASS_WEBHOOK");
  });
  test("the route composes it from the detail and only sends on request", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const at = src.indexOf('pathname === "/prs/nudge"');
    const body = src.slice(at, src.indexOf('pathname === "/prs/detail"', at));
    expect(body).toContain("nudgeText(got.detail)");
    expect(body).toContain("b.send === true && channel.configured ? await sendNudge(text) : null");
    expect(body).toContain("trustedCaller(req, from)");
  });
});
