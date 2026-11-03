/*
 * WHERE THE RUNNING SERVER IS, FOR EVERYTHING THAT CANNOT ASK THE APP.
 *
 * The desktop shell walks to :4001 when something else holds :4000, and then
 * the port exists nowhere a hook or a CLI looks: they default to 4000, and the
 * `AGENTGLASS_PORT` an agent pane inherits is whatever the tmux server was
 * started with, so it keeps saying 4000. Measured: Lantern posts and hook
 * events went to the stranger on :4000, which answers 200 and so reports no
 * error. The server writes the port it really bound next to the token file,
 * which every client already knows how to find, and removes it on a clean exit.
 *
 * Ceiling: a SIGKILLed server leaves its file behind, and a client then dials a
 * dead port exactly as it did before this file existed; the next boot rewrites
 * it. Clients read it before the environment and do not probe, because a hook
 * must not pay a round trip per event.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function portFilePath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "port");
}

let bound: number | null = null;
/** The port this process listens on, once it does. */
export const boundPort = (): number | null => bound;

/**
 * Whether this process is allowed to speak for the machine's server.
 *
 * An isolated instance (its own database or state dir) that kept the real
 * config dir would repoint every hook on the machine at itself.
 */
function mayPublish(): boolean {
  const redirected = !!process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== join(homedir(), ".config");
  return redirected || (!process.env.AGENTGLASS_DB && !process.env.AGENTGLASS_STATE_DIR);
}

export function publishPort(port: number): void {
  bound = port;
  if (!mayPublish()) return;
  try {
    const p = portFilePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${port}\n`);
  } catch { /* the file is a convenience; a server that cannot write it still serves */ }
}

/** Only our own line: a newer server may already have written its port. */
export function retractPort(): void {
  if (bound === null || !mayPublish()) return;
  try {
    const p = portFilePath();
    if (existsSync(p) && readFileSync(p, "utf8").trim() === String(bound)) rmSync(p);
  } catch { /* exiting anyway */ }
}
