/*
 * The settings changes agents asked for and wait on the person for (the server's
 * settings door), as a store the request cards read. Re-read when the server
 * says the list changed (the `settings-requests` frame) and once on start, never
 * on a timer: a request arrives as an event, and one that expires is announced
 * the same way.
 */
import { api } from "./api.ts";
import type { SettingRequestView } from "../../../shared/settingClass.ts";

let items: readonly SettingRequestView[] = [];
const subs = new Set<() => void>();

export const settingsRequests = {
  list: (): readonly SettingRequestView[] => items,
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
};

/** Fetch the list again; a failed read keeps what was shown. */
export async function settingsRequestsChanged(): Promise<void> {
  const r = await api.settingsRequests().catch(() => null);
  if (!r?.ok || !Array.isArray(r.requests)) return;
  items = r.requests;
  for (const f of subs) f();
}

/** An answer the server refused after the request had already left its list: the card is gone, so
 *  the refusal is kept here for the person to read (measured: Approve on a setting that changed since
 *  made the card vanish with no word, and it looked applied). */
export interface SettingRefusal { id: string; who: string; title: string; approve: boolean; error: string }
let refusals: readonly SettingRefusal[] = [];
export const settingsRefusals = {
  list: (): readonly SettingRefusal[] => refusals,
  subscribe: settingsRequests.subscribe,
  dismiss(id: string): void { refusals = refusals.filter((x) => x.id !== id); for (const f of subs) f(); },
};

/** The person's click. The card goes when the server's frame says the list changed; a refusal that
 *  outlives it is kept (settingsRefusals). A refusal with the card still there shows on the card. */
export async function answerSettingsRequest(id: string, approve: boolean, about: { who: string; title: string } = { who: "", title: "" }): Promise<string | null> {
  const r = await api.settingsRequestDecide(id, approve).catch(() => null);
  await settingsRequestsChanged();
  const error = r?.ok ? null : r?.error ?? "the server did not answer";
  if (error && !items.some((x) => x.id === id)) {
    refusals = [...refusals.filter((x) => x.id !== id), { id, ...about, approve, error }];
    for (const f of subs) f();
  }
  return error;
}
