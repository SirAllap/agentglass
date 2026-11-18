/* The one write of a review setting. The Safety and limits page and the
   Flow editor both go through it, so the door call lives in a single place. */
import { api } from "./api.ts";

export async function writeReviewSetting(id: string, value: number, root: string): Promise<{ ok: boolean; error?: string }> {
  return api.settingAtSet(id, value, root);
}
