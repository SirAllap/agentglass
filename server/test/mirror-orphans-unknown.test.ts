// Under load a tmux read times out, or is skipped for a few seconds after
// another one did. The orphan sweep read that silence as "nobody attached"
// and closed a phone's mirror session with the phone still on it.
import { expect, test } from "bun:test";
import { attachedOrUnknown, reapOrphanedMirrors } from "../src/tmuxctl.ts";

test("no answer from tmux is not an empty room", () => {
  expect(attachedOrUnknown(null, "agx-phone-1-aaa111")).toBe(true);
  expect(attachedOrUnknown("", "agx-phone-1-aaa111")).toBe(false);
});

test("the sweep keeps a stamped mirror it could not ask about, and still closes one it could", async () => {
  const killed: string[] = [];
  const answers: Record<string, string | null> = { "agx-phone-1-aaa111": null, "agx-phone-2-bbb222": "" };
  const out = await reapOrphanedMirrors(
    ["-L", "agx-none"],
    {
      readStamp: async () => "stamp",
      attached: async (_socket, session) => attachedOrUnknown(answers[session] ?? null, session),
      kill: async (_socket, session) => { killed.push(session); },
    },
    async () => Object.keys(answers),
  );
  expect(killed).toEqual(["agx-phone-2-bbb222"]);
  expect(out).toEqual(["agx-phone-2-bbb222"]);
});

const source = await Bun.file(new URL("../src/tmuxctl.ts", import.meta.url)).text();

test("both sweeps ask through the rule", () => {
  expect(source).toContain("return attachedOrUnknown(await tmuxAsync(socket, ATTACHED_ARGV), session);");
  expect(source).toContain("attached: async (socket, session) => attachedOrUnknown(await tmuxAsync(socket, ATTACHED_ARGV), session),");
});
