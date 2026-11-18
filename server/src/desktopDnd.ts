// The desktop's own Do Not Disturb, read and set through the desktop.
//
// Notifications v2 decides where a note shows from this one fact: DND on, the
// desktop draws nothing and agentglass shows cards; DND off, the desktop draws
// its popup and agentglass only keeps the row. There is no portable way to
// read it (GetServerInformation returns a name, not a state), so this asks the
// one desktop that answers: Omarchy's shell IPC, `omarchy-shell notifications
// isDnd` (prints on/off) and `setDnd`. Anywhere else the answer is
// `supported: false`, and the web keeps the switch as agentglass's own setting.
//
// Asked on demand (the bell opening, the window coming back), never on a timer,
// and never with a blocking spawn: a stuck shell must not stall the server.

import { runChild } from "./broker/brokerRun.ts";

export type DndState = { supported: boolean; on: boolean };

const BIN = "omarchy-shell";
const TIMEOUT_MS = 2000;

/** What `isDnd` printed, as a state. Anything but on/off is "not known here". */
export function parseDnd(out: string): boolean | null {
  const t = out.trim().toLowerCase();
  if (t === "on" || t === "true" || t === "1") return true;
  if (t === "off" || t === "false" || t === "0") return false;
  return null;
}

async function run(args: string[], read: boolean): Promise<{ code: number; out: string } | null> {
  const bin = process.platform === "linux" ? Bun.which(BIN) : null;
  if (!bin) return null;
  // In the spawn broker, so the fork of the big server never happens here.
  // The absolute path: the broker's PATH may resolve the bare name elsewhere.
  const r = await runChild([bin, ...args], { timeoutMs: TIMEOUT_MS, read });
  return r.code === null ? null : { code: r.code, out: r.stdout };
}

export async function readDnd(): Promise<DndState> {
  const r = await run(["notifications", "isDnd"], true);
  const on = r && r.code === 0 ? parseDnd(r.out) : null;
  return on === null ? { supported: false, on: false } : { supported: true, on };
}

export async function writeDnd(on: boolean): Promise<DndState> {
  // setDnd answers with the state it left, so no second call.
  const r = await run(["notifications", "setDnd", on ? "on" : "off"], false);
  const now = r && r.code === 0 ? parseDnd(r.out) : null;
  return now === null ? { supported: false, on: false } : { supported: true, on: now };
}
