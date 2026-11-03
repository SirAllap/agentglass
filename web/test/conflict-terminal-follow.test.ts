// "In a terminal" used to start the agent in a tmux window the person never saw.
import { expect, test } from "bun:test";
import { followHandoff, type LiveWindow } from "../src/lib/liveWindow.ts";

const w: LiveWindow = { session: "orbit", windowId: "@3", paneId: "%7", name: "conflicts", path: "/home/dev/orbit-wt" };

function run(done: { ok: boolean }, found: LiveWindow | null | "throws") {
  const calls: string[] = [];
  return followHandoff(
    done,
    async () => { if (found === "throws") throw new Error("down"); return found; },
    async (x) => { calls.push(`open ${x.windowId}`); },
    () => { calls.push("jump"); },
  ).then(() => calls);
}

test("first press: the agent started, so its tab opens", async () => {
  expect(await run({ ok: true }, w)).toEqual(["open @3"]);
});

test("reuse: the agent was already there, same path", async () => {
  expect(await run({ ok: true, reused: true } as { ok: boolean }, w)).toEqual(["open @3"]);
});

test("failure stays on the resolver and navigates nowhere", async () => {
  expect(await run({ ok: false }, w)).toEqual([]);
});

test("window not in the strip yet: the Terminal still comes forward", async () => {
  expect(await run({ ok: true }, null)).toEqual(["jump"]);
  expect(await run({ ok: true }, "throws")).toEqual(["jump"]);
});
