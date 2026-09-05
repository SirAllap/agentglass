#!/usr/bin/env bun
/*
 * The two mirrors `reapMirrorSessions` cannot reach: `agx-phone-…` sessions
 * that predate the stamp it verifies against, so no stamp will ever vouch for
 * them and the startup sweep correctly leaves them alone forever.
 *
 * This is the one-off answer for those — read-only, on purpose. It lists every
 * `agx-phone-…` session on every tmux socket this machine has, with no
 * attached client, and prints the exact `kill-session` for a person to run
 * after reading it. It kills nothing itself: an unstamped session is
 * indistinguishable from one this app is about to make (a phone reconnecting
 * mid-list), and the one thing worse than an orphan sitting around is a script
 * that guesses.
 *
 *     cd server && bun run scripts/list-orphan-mirrors.ts
 */
import { resolveTmuxBin } from "../src/tmuxbin.ts";
import { tmuxSockets, isPhoneSession, socketPath } from "../src/tmuxctl.ts";

const bin = resolveTmuxBin();
if (!bin) { console.error("tmux is not installed"); process.exit(1); }

let found = 0;
for (const socket of tmuxSockets()) {
  const r = Bun.spawnSync(
    [bin, ...socket, "list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_windows}"],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (r.exitCode !== 0) continue;
  for (const line of r.stdout.toString().trim().split("\n")) {
    const [name, attached, windows] = line.split("\t");
    if (!name || !isPhoneSession(name) || attached !== "0") continue;
    found++;
    console.log(`${name}  windows=${windows}  socket=${socketPath(socket)}`);
    console.log(`  ${bin} ${socket.join(" ")} kill-session -t ${name}\n`);
  }
}

if (!found) console.log("no unattached agx-phone-… sessions found.");
