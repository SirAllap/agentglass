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

/** The person's click. The card goes when the server's frame says the list changed. */
export async function answerSettingsRequest(id: string, approve: boolean): Promise<string | null> {
  const r = await api.settingsRequestDecide(id, approve).catch(() => null);
  void settingsRequestsChanged();
  return r?.ok ? null : r?.error ?? "the server did not answer";
}
