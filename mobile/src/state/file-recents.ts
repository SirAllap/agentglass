/*
 * The files opened on this phone, newest first, per checkout.
 *
 * Kept in memory for as long as the app is, like the viewed ticks: a list of
 * what you read on the way to a problem is useful for the next few minutes and
 * is stale a week later. It is the phone's own — the desk has its own recents
 * and the two do not sync, which is why the tab is called Recent and the row
 * under it says nothing about "last edited".
 */
import { remembered } from "../model/files.ts";
import { memoryStore } from "./memory-store.ts";

export const useRecents = memoryStore<readonly string[]>([], remembered);
