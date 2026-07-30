/*
 * "Allowed — the agent is moving again", about an agent that is not moving.
 *
 * A press that loses the race — the timeout got there first, or somebody
 * answered from the desk — comes back **200** with `ok: false`. It is not an
 * exception, so a `try/catch` around the call never sees it, and the phone said
 * the agent had been released about a request that was already decided the
 * other way. On the one surface built for answering gates, that is the worst
 * sentence available: it is confidently wrong about the exact thing somebody
 * opened the app to find out.
 *
 * Written over the file rather than by driving the component: `decide` is a
 * closure over queue state and cannot be imported, and what has to stay true is
 * smaller than any rendering — the response is read before anybody is told what
 * happened.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SHELL = readFileSync(new URL("../src/mobile/MobileApp.tsx", import.meta.url), "utf8");
const decide = SHELL.slice(SHELL.indexOf("const decide = async"), SHELL.indexOf("const settle = async"));

describe("answering a gate from the phone", () => {
  test("the answer is read, not assumed from the absence of a throw", () => {
    expect(decide).toMatch(/const r = await api\.gateDecide\(/);
    expect(decide, "a 200 that did not take is treated as success").toMatch(/if \(!r\.ok\)/);
  });

  test("and a press that did not take says so, in the server's words", () => {
    // The server knows what won — the clock, or another device. Inventing a
    // vaguer sentence here would throw away the only useful part.
    expect(decide).toMatch(/r\.error/);
  });

  test("the failure is toasted as a failure, not as news", () => {
    // `toast(text, true)` is the error styling. Without the flag this is the
    // same green note as a successful answer.
    expect(decide).toMatch(/toast\(r\.error[^)]*, true\)/);
  });

  test("and nothing that did reach the server is reported as unreachable", () => {
    // The catch is for a request that never arrived, which is a different
    // problem with a different answer: there, the agent really is still waiting.
    expect(decide).toMatch(/still waiting/);
  });
});

describe("what the client type admits", () => {
  const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  const fn = api.slice(api.indexOf("gateDecide: (id: string"), api.indexOf("gitStatus:"));

  test("gateDecide can come back not-ok, and the type says so", () => {
    // The call used to be typed `any`, which is how every caller came to treat
    // "it resolved" as "it worked".
    expect(fn).toMatch(/ok: boolean; error\?: string/);
  });
});
