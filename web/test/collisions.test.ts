// A fleet row carries the collisions its own session is a party to, and says
// who the other side is. The row is where you are already looking when you
// decide which agent to trust, so the chip has to name the resource and the
// tooltip has to name the other checkout and what it ran.
import { expect, test } from "bun:test";
import { collisionChip, collisionTitle, collisionsFor, shortResource } from "../src/lib/collisions.ts";
import type { Collision } from "../../shared/types.ts";

const party = (session_id: string, checkout: string, evidence: string, via: "command" | "file" | "listening" = "command") =>
  ({ source_app: "orbit", session_id, checkout, via, evidence, ts: 1 });

const list: Collision[] = [
  {
    kind: "postgres",
    resource: "postgres localhost:5432/acme_dev",
    parties: [
      party("aaaa1111-0000", "/work/wt-a", "DATABASE_URL=postgres://…@localhost:5432/acme_dev bunx prisma migrate dev"),
      party("bbbb2222-0000", "/work/wt-b", "bunx prisma migrate dev"),
    ],
  },
  {
    kind: "port",
    resource: "port 3000",
    parties: [
      party("aaaa1111-0000", "/work/wt-a", "bun (pid 42) listening on 127.0.0.1:3000", "listening"),
      party("cccc3333-0000", "/work/wt-c", "curl localhost:3000/health"),
    ],
  },
];

test("a session sees only the collisions it is a party to, and the other side of each", () => {
  const a = collisionsFor(list, "orbit", "aaaa1111-0000");
  expect(a.map((n) => n.resource)).toEqual(["postgres localhost:5432/acme_dev", "port 3000"]);
  expect(a[0].others.map((p) => p.session_id)).toEqual(["bbbb2222-0000"]);
  expect(collisionsFor(list, "orbit", "cccc3333-0000").map((n) => n.resource)).toEqual(["port 3000"]);
  expect(collisionsFor(list, "orbit", "dddd4444-0000")).toEqual([]);
  // The same id under another app is another session.
  expect(collisionsFor(list, "acme", "aaaa1111-0000")).toEqual([]);
});

test("the chip names the first resource briefly and counts the rest", () => {
  expect(collisionChip(collisionsFor(list, "orbit", "aaaa1111-0000"))).toBe("shares postgres acme_dev +1");
  expect(collisionChip(collisionsFor(list, "orbit", "cccc3333-0000"))).toBe("shares port 3000");
  expect(shortResource({ kind: "env", resource: "env /work/.env.local" })).toBe("env .env.local");
  expect(shortResource({ kind: "compose", resource: "compose acme" })).toBe("compose acme");
  expect(shortResource({ kind: "redis", resource: "redis localhost:6379/0" })).toBe("redis localhost:6379/0");
});

test("the tooltip says it is a possibility, names the other checkout and what it ran", () => {
  const t = collisionTitle(collisionsFor(list, "orbit", "cccc3333-0000"));
  expect(t).toMatch(/^Possible collision/);
  expect(t).toContain("port 3000");
  expect(t).toContain("orbit:aaaa1111 in wt-a");
  expect(t).toContain("listening on 127.0.0.1:3000");
  // Its own evidence is its own business — the row already says what it ran.
  expect(t).not.toContain("curl localhost:3000/health");
});
