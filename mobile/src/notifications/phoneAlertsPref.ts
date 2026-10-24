/*
 * "Alerts on this phone", as the computer keeps it.
 *
 * Not a device preference like talkPref.ts: the desk shows this switch as a
 * channel of its own and an agent can read it through the settings door, so the
 * value lives on the computer (`phone.alerts`, server/src/serverSettings.ts)
 * and the phone asks. It is read each time an alert is about to be drawn rather
 * than polled, which is a request per fire and none otherwise.
 *
 * One switch for every phone paired to that computer. Changing it needs a phone
 * paired with full access, like any other write the phone makes; a read-only
 * phone can read it and is told so.
 */
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";

export const PHONE_ALERTS_ID = "phone.alerts";

/** The computer's answer, or null when it could not be asked. */
export async function readPhoneAlerts(host: Host): Promise<boolean | null> {
  const answer = await ask<{ ok: boolean; value?: unknown }>(host, `/settings/door?id=${PHONE_ALERTS_ID}`);
  return answer.ok && typeof answer.value.value === "boolean" ? answer.value.value : null;
}

export async function setPhoneAlerts(host: Host, on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const answer = await ask<{ ok: boolean }>(host, "/settings/door", { method: "POST", body: { id: PHONE_ALERTS_ID, value: on } });
  return answer.ok ? { ok: true } : { ok: false, error: answer.error };
}
