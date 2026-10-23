/*
 * The name of the computer this phone is paired to.
 *
 * `host.label` is NOT it. That is what the person at the desk called the PHONE
 * when they accepted it ("My phone"), and four screens drew it where they meant
 * the computer: "Connected to My phone". The server says its own name on
 * `/pair/whoami`, which needs the credential, so a stranger on the network does
 * not learn it from `/health`.
 *
 * Until it answers, and against a server too old to say, the address is the
 * name: `192.168.1.20` is at least the machine, which the phone's label never
 * was. Asked once per address per launch: a computer does not rename itself
 * while somebody is looking at it.
 */
import { useEffect, useState } from "react";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";

const known = new Map<string, string>();

/** The address's host part, for when the computer has not said its name. */
export function addressName(origin: string): string {
  const m = /^[a-z]+:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(origin);
  return m?.[1] ?? origin;
}

/** What the server said, or the address when it said nothing usable. A
 *  `.local` suffix is how macOS names itself on the LAN and says nothing
 *  a person needs. */
export function computerName(said: unknown, origin: string): string {
  if (typeof said === "string" && said.trim()) return said.trim().replace(/\.local$/i, "");
  return addressName(origin);
}

/** What a computer last said its name was, if this run has asked it. */
export function saidName(origin: string): string | undefined {
  return known.get(origin);
}

export function useComputer(host: Host | null): string {
  const origin = host?.origin ?? "";
  const [name, setName] = useState(() => known.get(origin) ?? computerName(null, origin));

  useEffect(() => {
    if (!host) return;
    setName(known.get(host.origin) ?? computerName(null, host.origin));
    if (known.has(host.origin)) return;
    let alive = true;
    void ask<{ computer?: unknown }>(host, "/pair/whoami").then((answer) => {
      if (!answer.ok) return; // offline keeps the address
      const said = computerName(answer.value.computer, host.origin);
      known.set(host.origin, said);
      if (alive) setName(said);
    });
    return () => { alive = false; };
  }, [host]);

  return name;
}
