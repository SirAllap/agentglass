/*
 * The computer this phone is paired to, and the credential for it.
 *
 * What the rest of the app sees is still ONE computer: the active one. The
 * list of all of them, the keystore value and the migration from the old
 * single record live in hosts.ts; this file is the view the 28 screens that
 * read `host` were written against, so none of them moves.
 *
 * Kept in the OS keystore (Android Keystore via expo-secure-store) rather than
 * in ordinary app storage. The browser companion has no equivalent
 * — it keeps its token in `localStorage`, which is the best a web page can do
 * and is readable by anything that can run script in that origin.
 *
 * The whole record goes in together, including the address, which is not a
 * secret. Splitting it would buy nothing and cost the property that matters
 * here: a token and the machine it opens are either both present or both gone,
 * so there is no state where the app holds a working credential and does not
 * know what it is for.
 */
import type { DeviceScope } from "../../../shared/types.ts";
import { addHost, loadHosts, removeHost, type HostEntry } from "./hosts.ts";

export interface Host {
  /** `http://192.168.1.20:4000` — scheme, host and port, no trailing slash. */
  origin: string;
  /** The device credential. Sent as a bearer token on every request. */
  token: string;
  /** What the person at the computer named this phone when they accepted it. */
  label: string;
  /** What they granted. The server enforces it; this is for saying so. */
  scope: DeviceScope;
  pairedAt: number;
}

/** The active computer. Null when this phone has never been paired, or
 *  forgot them all. */
export async function loadHost(): Promise<HostEntry | null> {
  const { active, hosts } = await loadHosts();
  return hosts.find((h) => h.id === active) ?? null;
}

/** Pair a computer and make it the active one. */
export async function saveHost(host: Host): Promise<void> {
  await addHost(host);
}

/**
 * Forget the active computer.
 *
 * This is the phone's half only — it drops the credential it holds. The token
 * stays valid on the computer until somebody revokes the device there, which
 * is deliberate: a phone cannot be trusted to say "and revoke me", because a
 * phone that has been taken is exactly the one that will not.
 */
export async function forgetHost(): Promise<void> {
  const { active } = await loadHosts();
  if (active) await removeHost(active);
}
