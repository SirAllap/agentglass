/*
 * The ports column, turned into something you can click.
 *
 * `docker ps` hands over one string per container and it is not a list, it is a
 * sentence: `0.0.0.0:8000->8000/tcp, :::8000->8000/tcp, 5432/tcp`. Three facts
 * are buried in there — what is published, on which host address, and what is
 * merely exposed — and today the panel prints the sentence and leaves the
 * reading to you.
 *
 * Parsing it here rather than in the component is what lets a port become a
 * link, and it costs nothing: the string is already in the poll's answer, so
 * this adds no docker call at all. That is the whole point of doing it in the
 * fast lane.
 */

/* The shape lives in shared/types.ts: the panel receives these over the wire,
   so a second definition here would be a copy waiting to drift. */
import type { DockerPort } from "../../shared/types.ts";
export type { DockerPort };

/**
 * Ports that answer TCP and are not web servers.
 *
 * Deliberately short. Every entry is a port somebody would otherwise click once
 * and get an empty tab from; anything unusual stays clickable, because a dev
 * server on 4321 is far more likely than a database there.
 */
const NOT_WEB = new Set([
  22,     // ssh
  25, 465, 587, 1025,  // smtp (1025 is mailpit/mailhog's)
  53,     // dns
  110, 143, 993, 995,  // pop/imap
  3306,   // mysql
  5432,   // postgres
  5672,   // amqp
  6379,   // redis
  9092,   // kafka
  11211,  // memcached
  27017,  // mongo
]);

/** `0.0.0.0:8000->8000/tcp` and its variants, including IPv6 in both spellings
 *  docker uses (`:::8000` and `[::]:8000`) and host/container ranges. */
const PUBLISHED = /^(?:(\[[^\]]+\]|[^\s:]+|::):)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(tcp|udp)$/;
/** `5432/tcp` — exposed by the image, not published to the host. */
const EXPOSED = /^(\d+)(?:-(\d+))?\/(tcp|udp)$/;

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
};

/** `[::]` and `::` both mean "every address"; normalised so the UI has one
 *  spelling to reason about and the dedup below actually collapses the pair. */
const cleanIp = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const ip = raw.replace(/^\[|\]$/g, "");
  return ip === "::" || ip === "0.0.0.0" ? "0.0.0.0" : ip;
};

/**
 * The mappings in that string, deduped and in the order docker gave them.
 *
 * Docker publishes IPv4 and IPv6 as two entries for one mapping
 * (`0.0.0.0:8000->8000/tcp, :::8000->8000/tcp`) and showing both is showing the
 * same port twice — so identical host/container/proto triples collapse.
 *
 * Anything that does not parse is skipped rather than guessed at: the caller
 * keeps the raw string and shows it when this comes back empty, so a format
 * this does not know about degrades to exactly what the panel does today.
 */
export function parsePorts(raw: string | null | undefined): DockerPort[] {
  if (!raw) return [];
  const out: DockerPort[] = [];
  const seen = new Set<string>();
  for (const chunkRaw of raw.split(",")) {
    const chunk = chunkRaw.trim();
    if (!chunk) continue;

    let port: DockerPort | null = null;
    const pub = PUBLISHED.exec(chunk);
    if (pub) {
      const host = num(pub[2]);
      const container = num(pub[4]);
      if (host === null || container === null) continue;
      port = {
        host,
        hostEnd: num(pub[3]) ?? host,
        hostIp: cleanIp(pub[1]),
        container,
        containerEnd: num(pub[5]) ?? container,
        proto: pub[6] as "tcp" | "udp",
        web: false,
      };
    } else {
      const exp = EXPOSED.exec(chunk);
      if (!exp) continue;
      const container = num(exp[1]);
      if (container === null) continue;
      port = {
        host: null, hostEnd: null, hostIp: null,
        container, containerEnd: num(exp[2]) ?? container,
        proto: exp[3] as "tcp" | "udp",
        web: false,
      };
    }

    port.web = port.host !== null && port.proto === "tcp" && !NOT_WEB.has(port.container);
    const key = `${port.host}:${port.container}/${port.proto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(port);
  }
  return out;
}

/* The presentation half — how a port reads and where it points — lives in
   shared/dockerPort.ts, because the panel needs exactly the same answer and a
   chip that disagrees with its own link is a bug nobody reports. Re-exported
   here so this module stays the one import for anything port-shaped. */
export { portLabel, portUrl, firstReachable } from "../../shared/dockerPort.ts";
