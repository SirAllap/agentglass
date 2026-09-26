// The fake install the installer tests drive electron/appctl.sh against.
import { mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const APPCTL = join(import.meta.dir, "..", "..", "electron", "appctl.sh");

/** Wait, inside the shell, for the reopened instance to exist — see `visible` in
 *  install-stop.test.ts, on the other side of the process boundary. */
export const AWAIT_MAIN = 'for _ in $(seq 200); do [ -n "$(main_pids)" ] && break; sleep 0.025; done';

/** A fake install: our own copy of a shell, named the way the real one is. The
 *  copy matters — /proc/<pid>/exe has to point inside the install directory. */
export function fakeInstall(prefix = "agx-install-") {
  const app = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(app, "resources"));
  copyFileSync("/bin/sh", join(app, "agentglass"));
  copyFileSync("/bin/sh", join(app, "resources", "agentglass-server"));
  return app;
}
