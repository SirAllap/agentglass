/*
 * The computer this phone is paired to, and the credential for it.
 *
 * One record, in the OS keystore (Android Keystore via expo-secure-store)
 * rather than in ordinary app storage. The browser companion has no equivalent
 * — it keeps its token in `localStorage`, which is the best a web page can do
 * and is readable by anything that can run script in that origin.
 *
 * The whole record goes in together, including the address, which is not a
 * secret. Splitting it would buy nothing and cost the property that matters
 * here: a token and the machine it opens are either both present or both gone,
 * so there is no state where the app holds a working credential and does not
 * know what it is for.
 */
import * as SecureStore from "expo-secure-store";
import type { DeviceScope } from "../../../shared/types.ts";

const KEY = "agentglass.host";

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

/** Null when this phone has never been paired, or was forgotten. */
export async function loadHost(): Promise<Host | null> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(KEY);
  } catch {
    // A keystore that will not open is not an empty keystore, but there is
    // nothing the app can do differently either way, and the pairing screen is
    // the right place to land from both.
    return null;
  }
  if (!raw) return null;
  try {
    const host = JSON.parse(raw) as Partial<Host>;
    if (!host.origin || !host.token) return null;
    return {
      origin: host.origin,
      token: host.token,
      label: host.label || "This computer",
      scope: host.scope ?? "answer",
      pairedAt: host.pairedAt ?? 0,
    };
  } catch {
    return null;
  }
}

export async function saveHost(host: Host): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(host), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

/**
 * Forget the computer.
 *
 * This is the phone's half only — it drops the credential it holds. The token
 * stays valid on the computer until somebody revokes the device there, which
 * is deliberate: a phone cannot be trusted to say "and revoke me", because a
 * phone that has been taken is exactly the one that will not.
 */
export async function forgetHost(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    /* nothing stored, or a keystore that will not open — same outcome */
  }
}
