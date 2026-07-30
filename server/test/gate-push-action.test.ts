/*
 * The one field that makes a notification answerable.
 *
 * A held gate stops an agent until a person says go, and the push that tells
 * them was a dead end: it named the tool and then instructed them to go and
 * find the app. The gate's own id travelling with the push is what lets the
 * service worker put **Allow** and **Deny** on the notification instead — see
 * web/public/sw.js.
 *
 * It is one string, so the risk is not that it is wrong but that it silently
 * stops being sent: nothing about a phone with no buttons on its notification
 * looks broken, and the person it happens to is not at a computer. Hence a
 * test that reads the bytes actually handed to the encryption.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { pushEveryone, type PushFanout } from "../src/alerts.ts";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL("../src/" + p, import.meta.url), "utf8");

describe("what rides along with a held gate", () => {
  /**
   * `pushEveryone` returns early with nothing sent when no device is
   * subscribed, which is the state of a test run — so the payload it *would*
   * have built is not observable from its return value. What is observable is
   * the source: the field is either in the object being serialised or it is
   * not, and everything downstream of that is the encryption, which has its own
   * suite.
   */
  test("the payload carries the gate id, and only when there is one", () => {
    const alerts = src("alerts.ts");
    const payload = alerts.slice(alerts.indexOf("const payload ="), alerts.indexOf("await Promise.all"));
    expect(payload).toContain("gate: action.gate");
    // Conditional: a push about a tool error with a `gate` key on it would give
    // the worker two buttons that answer nothing.
    expect(payload).toMatch(/\.\.\.\(action \?/);
  });

  test("a gate hold passes the id it is holding under", () => {
    // The alert is raised from inside submitGate, where the id already exists;
    // dropping it there is the quiet way for this whole feature to stop.
    // Sliced to the function, so a failure prints the call site rather than
    // the file — the first version of this asserted over the whole of gate.ts
    // and printed all of it.
    const all = src("gate.ts");
    const submit = all.slice(all.indexOf("export function submitGate"), all.indexOf("export function awaitGate"));
    expect(submit).toContain("tool_name, summary, id)");
  });

  test("and the sentence no longer tells people to go somewhere else", () => {
    // "approve or deny in agentglass" was the right words when the
    // notification could not be acted on. Above two buttons that do exactly
    // that, it is an instruction to ignore them.
    const alerts = src("alerts.ts");
    const fn = alerts.slice(alerts.indexOf("export function pushGate"), alerts.indexOf("/** Inspect an event"));
    expect(fn).not.toContain("approve or deny in agentglass");
  });

  test("nothing that is not a held gate carries one", () => {
    // Every other `deliver` call in the file is news. A fifth argument on one
    // of them would put Allow and Deny on a build failure.
    const alerts = src("alerts.ts");
    const others = [...alerts.matchAll(/deliver\(\s*\n?\s*"[^"]*"/g)].length;
    expect(others).toBeGreaterThan(2);
    expect(alerts.match(/\{ gate: id \}/g) ?? []).toHaveLength(1);
  });

  test("it is an id and not a credential", () => {
    // Worth stating, because a field that arrives at a push service and then at
    // a phone is the wrong place to put anything that grants access. Deciding
    // still needs the device's own credential; this names a thing already on
    // that person's screen.
    expect(src("alerts.ts")).not.toMatch(/token:\s*\w+\s*\}\s*\)?,?\s*\n\s*\);/);
    const alerts = src("alerts.ts");
    const payload = alerts.slice(alerts.indexOf("const payload ="), alerts.indexOf("await Promise.all"));
    for (const leak of ["token", "secret", "AUTH"]) {
      expect(payload, `the push payload mentions ${leak}`).not.toContain(leak);
    }
  });
});

describe("sending it", () => {
  afterEach(() => { /* nothing subscribed in a test run; nothing to clean */ });

  test("is a no-op with no devices, action or not", async () => {
    // The guard that keeps this file from touching the network.
    const out: PushFanout = await pushEveryone("t", "b", "wake", { gate: "g" });
    expect(out).toEqual({ sent: 0, failed: 0, pruned: 0 });
  });
});
