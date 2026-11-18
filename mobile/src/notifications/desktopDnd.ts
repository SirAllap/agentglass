/*
 * The computer's own Do Not Disturb, as the desk keeps it (`GET /notify/dnd`).
 *
 * Read each time an alert is about to be drawn, like phoneAlertsPref.ts: a
 * request per fire and none otherwise. A computer that cannot say (offline,
 * `supported: false`, an old build) counts as off, so the phone never goes
 * silent on a guess.
 */
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";

export async function readDesktopDnd(host: Host, send: typeof ask = ask): Promise<boolean> {
  const answer = await send<{ ok: boolean; supported?: boolean; on?: unknown }>(host, "/notify/dnd");
  return answer.ok && answer.value.supported === true && answer.value.on === true;
}
