// The first start after an update took 20 s to listen (a database rewrite) and
// the window, told "no server" at 12 s, never looked again. The shell now keeps
// asking while the process is alive and reloads the windows when it answers.
import { expect, test } from "bun:test";

const source = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();

test("a server that answers after the wait is still noticed, and only while its process lives", () => {
  const at = source.indexOf("for (let i = 0; i < LATE_START_TRIES; i++)");
  expect(at).toBeGreaterThan(-1);
  const body = source.slice(at, source.indexOf("\n  })();", at));
  expect(body).toContain("if (spawnError || exit || sidecar !== child) return;");
  expect(body).toMatch(/probe\(port\)\) !== "ours"\) continue;/);
  expect(body).toContain("reportSidecar(null);");
  expect(body).toContain("w.webContents.reload()");
  expect(source).toMatch(/const LATE_START_TRIES = 15 \* 60;/);
});
