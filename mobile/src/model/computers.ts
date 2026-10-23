/*
 * What the computer list says, decided here and drawn elsewhere.
 *
 * The switcher, the Computers screen, the forget confirmation and the Add form
 * all word the same few facts — what a computer is called, whether it answers,
 * who you land on when you forget the one in use, whether an address typed is
 * one already on the list. Written once, so the sheet and the screen cannot
 * disagree, and tested, because there is no renderer to look at them.
 */
import type { HostEntry, HostList } from "../lib/hosts.ts";
import { MAX_HOSTS } from "../lib/hosts.ts";
import { readPairingCode } from "../lib/pairing.ts";
import { addressName } from "../state/use-computer.ts";
import type { LiveState } from "../lib/live.ts";

/** `checking`: the phone has no evidence yet. Drawn as neither green nor red,
 *  because a dot that claims a computer is up when nothing asked is the one
 *  lie this list must not tell. */
export type ComputerStatus = "online" | "offline" | "removed" | "checking";

/** The owner's alias, else what the computer calls itself, else its address. */
export function displayName(entry: HostEntry, said?: string): string {
  if (entry.name) return entry.name;
  if (said && said.trim()) return said.trim();
  return addressName(entry.origin);
}

/**
 * `live` is the socket of the computer in use; `own` is the socket kept for
 * THIS computer, when it has one. A removed computer is removed whatever a
 * socket says, because a 401 is the one answer that does not get better.
 */
export function statusOf(entry: HostEntry, isActive: boolean, live: LiveState, own?: LiveState): ComputerStatus {
  if (entry.revoked) return "removed";
  const state = own ?? (isActive ? live : undefined);
  if (state === "open") return "online";
  if (state === "offline") return "offline";
  return "checking";
}

export function statusWord(status: ComputerStatus): string {
  switch (status) {
    case "online": return "Online";
    case "offline": return "Not answering";
    case "removed": return "Removed at the computer";
    case "checking": return "Checking";
  }
}

/** The notification title. The computer is named only when there is more than
 *  one, so a phone with a single computer reads exactly as it always did. */
export function alertTitle(title: string, computer: string, paired: number): string {
  return paired >= 2 ? `${computer}: ${title}` : title;
}

/** The line under a computer's name in the switcher. */
export function switcherSub(status: ComputerStatus, waiting: number): string {
  if (status !== "online") return statusWord(status);
  return waiting > 0 ? `${waiting} waiting on you` : statusWord(status);
}

/** What forgetting `id` means for where you are. Empty when it changes nothing
 *  for you: the computer in use is not the one going. */
export function forgetNote(list: HostList, id: string, nameOf: (h: HostEntry) => string): string {
  if (list.active !== id) return "";
  const next = list.hosts.find((h) => h.id !== id);
  return next
    ? `You will switch to ${nameOf(next)}.`
    : "That was the last one, so you land on Connect to your computer.";
}

/** A pasted link or a scan carries the address; a bare ticket (12 characters,
 *  no address in them) does not, and only then does the form ask for one. */
export function needsAddress(text: string): boolean {
  const read = readPairingCode(text);
  return !!read && !read.origin;
}

/** The badge on the name: agents waiting on a person on the OTHER computers. */
export function waitingElsewhere(
  list: HostList,
  waiting: Record<string, number>,
  states: Record<string, LiveState>,
): number {
  let sum = 0;
  for (const h of list.hosts) {
    if (h.id === list.active || h.revoked || states[h.id] !== "open") continue;
    sum += waiting[h.id] ?? 0;
  }
  return sum;
}

export const capReached = (list: HostList): boolean => list.hosts.length >= MAX_HOSTS;
