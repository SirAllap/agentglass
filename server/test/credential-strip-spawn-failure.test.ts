/* A tmux that could not even be spawned is not "no server": the strip must not
   report success, or a pane starts while a live server still holds credentials. */
import { expect, test } from "bun:test";
import { credentialsStripped } from "../src/tmuxctl.ts";

test("a failed spawn of the probe is not a clean strip", async () => {
  const bin = "/nonexistent/agx-no-such-tmux";
  expect(await credentialsStripped(["-L", "agx-spawn-fail-probe"], bin)).toBe(false);
});
