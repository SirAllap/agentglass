/*
 * How a container port reads, and where it points.
 *
 * Shared because both halves need the same answer: the server parses the ports
 * column (server/src/dockerports.ts) and the panel draws it, and a chip that
 * says `:8000` while the link goes somewhere else is the kind of bug nobody
 * reports — they just stop trusting the chip.
 */
import type { DockerPort } from "./types.ts";

/** `:8000`, `:8000-8002`, or `8000/tcp` for a port that is only exposed and so
 *  not reachable from here. The host port is the one you would type. */
export function portLabel(p: DockerPort): string {
  if (p.host === null) return `${p.container}${p.containerEnd !== p.container ? `-${p.containerEnd}` : ""}/${p.proto}`;
  return `:${p.host}${p.hostEnd !== null && p.hostEnd !== p.host ? `-${p.hostEnd}` : ""}`;
}

/**
 * The address to open, or null when there is nothing to open.
 *
 * `0.0.0.0` is a bind address, not a destination: it means "every interface",
 * which as a URL is nothing. A specific address is kept as it is, because a
 * container bound only to 127.0.0.1 and one bound to a LAN address are
 * different answers to "can I send this link to somebody?".
 */
export function portUrl(p: DockerPort): string | null {
  if (p.host === null || !p.web) return null;
  const host = !p.hostIp || p.hostIp === "0.0.0.0" ? "localhost" : p.hostIp.includes(":") ? `[${p.hostIp}]` : p.hostIp;
  return `http://${host}:${p.host}`;
}

/** The port a row should show: the first one you can actually open, falling
 *  back to the first published one, then to whatever there is. A row has space
 *  for one; the rest live in the tooltip. */
export function firstReachable(ports: DockerPort[] | undefined): DockerPort | null {
  if (!ports?.length) return null;
  return ports.find((p) => p.web) ?? ports.find((p) => p.host !== null) ?? ports[0]!;
}
