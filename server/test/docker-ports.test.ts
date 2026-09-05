/*
 * Reading the ports column.
 *
 * The panel is about to turn these into links, so being wrong is not cosmetic:
 * a port that is only *exposed* is not reachable and must never look clickable,
 * and `0.0.0.0` is a bind address, not somewhere you can point a browser.
 *
 * The formats pinned here are the ones docker actually emits — both spellings
 * of IPv6 included, because it emits the same mapping twice and showing a port
 * twice is how you learn nobody parsed it.
 */
import { describe, expect, test } from "bun:test";
import { parsePorts, portLabel, portUrl } from "../src/dockerports.ts";

describe("what docker puts in that column", () => {
  test("a published port, with its host address", () => {
    expect(parsePorts("0.0.0.0:8000->8000/tcp")).toEqual([
      { host: 8000, hostEnd: 8000, hostIp: "0.0.0.0", container: 8000, containerEnd: 8000, proto: "tcp", web: true },
    ]);
  });

  test("the IPv4 and IPv6 halves of one mapping are one port", () => {
    // Docker prints both. They are the same door.
    const p = parsePorts("0.0.0.0:8000->8000/tcp, :::8000->8000/tcp");
    expect(p).toHaveLength(1);
    expect(p[0]!.host).toBe(8000);
  });

  test("and the bracketed IPv6 spelling parses too", () => {
    expect(parsePorts("[::]:9000->9000/tcp")).toHaveLength(1);
  });

  test("a port bound to localhost keeps that address", () => {
    // It is the difference between a link you can share and one only you can open.
    expect(parsePorts("127.0.0.1:5555->5555/tcp")[0]!.hostIp).toBe("127.0.0.1");
  });

  test("an exposed-but-not-published port has no host port", () => {
    const p = parsePorts("5432/tcp");
    expect(p[0]).toMatchObject({ host: null, container: 5432, web: false });
  });

  test("a range keeps both ends", () => {
    expect(parsePorts("0.0.0.0:8000-8002->8000-8002/tcp")[0])
      .toMatchObject({ host: 8000, hostEnd: 8002, container: 8000, containerEnd: 8002 });
  });

  test("a random published port maps to the container's own", () => {
    expect(parsePorts("0.0.0.0:32768->80/tcp")[0]).toMatchObject({ host: 32768, container: 80, web: true });
  });

  test("several mappings, in the order they came", () => {
    expect(parsePorts("0.0.0.0:8000->8000/tcp, 0.0.0.0:5555->5555/tcp, 5432/tcp").map((p) => p.container))
      .toEqual([8000, 5555, 5432]);
  });

  test("nothing at all is not an error", () => {
    expect(parsePorts("")).toEqual([]);
    expect(parsePorts(null)).toEqual([]);
    expect(parsePorts(undefined)).toEqual([]);
  });

  /* A format this does not know about must not become a wrong port. The caller
     falls back to printing the raw string, which is exactly what the panel does
     today — so the worst case of a parser miss is today's behaviour. */
  test("something unparseable is skipped, not guessed", () => {
    expect(parsePorts("something-else-entirely")).toEqual([]);
    expect(parsePorts("0.0.0.0:99999->80/tcp")).toEqual([]);
  });
});

describe("which ones are worth offering to open", () => {
  test("published TCP is openable", () => {
    expect(parsePorts("0.0.0.0:4321->4321/tcp")[0]!.web).toBe(true);
  });

  test("a database is not, however it is published", () => {
    // One dead tab is cheap; hiding a dev server on an odd port is not. So the
    // list of exceptions is short and famous.
    expect(parsePorts("0.0.0.0:5432->5432/tcp")[0]!.web).toBe(false);
    expect(parsePorts("0.0.0.0:6379->6379/tcp")[0]!.web).toBe(false);
    expect(parsePorts("0.0.0.0:1025->1025/tcp")[0]!.web).toBe(false);
  });

  test("neither is UDP, nor anything unpublished", () => {
    expect(parsePorts("0.0.0.0:5353->53/udp")[0]!.web).toBe(false);
    expect(parsePorts("8080/tcp")[0]!.web).toBe(false);
  });
});

describe("how it reads and where it points", () => {
  test("the chip says the host port, because that is the one you type", () => {
    expect(portLabel(parsePorts("0.0.0.0:8000->80/tcp")[0]!)).toBe(":8000");
    expect(portLabel(parsePorts("0.0.0.0:8000-8002->8000-8002/tcp")[0]!)).toBe(":8000-8002");
    expect(portLabel(parsePorts("5432/tcp")[0]!)).toBe("5432/tcp");
  });

  test("0.0.0.0 becomes localhost — it is a bind address, not a destination", () => {
    expect(portUrl(parsePorts("0.0.0.0:8000->8000/tcp")[0]!)).toBe("http://localhost:8000");
  });

  test("a specific address is kept as it is", () => {
    expect(portUrl(parsePorts("192.168.1.40:8080->80/tcp")[0]!)).toBe("http://192.168.1.40:8080");
    // Docker brackets a specific IPv6 address; a bare one with colons in it is
    // not a shape it emits, and guessing at it would be inventing a port.
    expect(portUrl(parsePorts("[fd00::1]:8080->80/tcp")[0]!)).toBe("http://[fd00::1]:8080");
  });

  test("and there is no url for what cannot be opened", () => {
    expect(portUrl(parsePorts("5432/tcp")[0]!)).toBe(null);
    expect(portUrl(parsePorts("0.0.0.0:5432->5432/tcp")[0]!)).toBe(null);
  });
});
