/*
 * Two checkouts can each be green and still share the one thing neither diff
 * contains: a dev server's port, a database, an .env above both trees, a
 * compose project. These cases pin what the detector reads out of a command,
 * what it will and will not call a collision, and that a session which has
 * ended or gone quiet stops counting.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-collisions-"));
process.env.AGENTGLASS_DB = join(dir, "collisions.db");
delete process.env.AGENTGLASS_ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let col: typeof import("../src/collisions.ts");
const now = Date.now();

beforeAll(async () => {
  db = await import("../src/db.ts");
  col = await import("../src/collisions.ts");
});
afterAll(() => {
  delete process.env.AGENTGLASS_DB;
});

const keys = (cmd: string, cwd: string | null = "/work/orbit") =>
  col.claimsFromCommand(cmd, cwd).map((c) => `${c.kind} ${c.key}`).sort();

describe("claimsFromCommand", () => {
  test("ports: env assignment, flags, docker publish, host:port", () => {
    expect(keys("PORT=3000 bun run dev")).toEqual(["port 3000"]);
    expect(keys("vite --port 5173")).toEqual(["port 5173"]);
    expect(keys("vite --port=5174")).toEqual(["port 5174"]);
    expect(keys("docker run -p 8080:80 nginx")).toEqual(["port 8080"]);
    expect(keys("docker run --publish 127.0.0.1:9000:9000 minio")).toEqual(["port 9000"]);
    expect(keys("curl -s http://localhost:4000/health")).toEqual(["port 4000"]);
    expect(keys("curl 127.0.0.1:4001")).toEqual(["port 4001"]);
  });

  test("ports that are not a service are not claimed", () => {
    // A privileged port is not a dev server, `mkdir -p` takes a path, and
    // ssh's -p is somebody else's machine.
    expect(keys("ssh -p 2222 build@ci.example")).toEqual([]);
    expect(keys("mkdir -p dist/assets")).toEqual([]);
    expect(keys("curl http://localhost:80/")).toEqual([]);
    expect(keys("git log -p -3")).toEqual([]);
  });

  test("a database client's port is the server it talks to, not one it binds", () => {
    // Two checkouts each on their own database of the one local Postgres is
    // the normal setup; the server's port in a client's flags is not shared
    // by them any more than it is inside a URL.
    expect(keys("psql -h localhost -p 5432 -d acme_a")).toEqual([]);
    expect(keys("PGPASSWORD=x psql -p 5433 -d acme_b")).toEqual([]);
    expect(keys("pg_dump --port=5432 acme_a")).toEqual([]);
    expect(keys("redis-cli -p 6379 ping")).toEqual([]);
    expect(keys("mysql -h 127.0.0.1 --port 3306 acme")).toEqual([]);
    // The server itself still claims it.
    expect(keys("redis-server --port 6390")).toEqual(["port 6390"]);
  });

  test("postgres and redis URLs name the database, never the credentials", () => {
    const pg = col.claimsFromCommand("DATABASE_URL=postgres://app:hunter2@127.0.0.1:5432/acme_dev bunx prisma migrate dev", "/work/orbit");
    expect(pg.map((c) => `${c.kind} ${c.key}`)).toEqual(["postgres localhost:5432/acme_dev"]);
    expect(JSON.stringify(pg)).not.toContain("hunter2");
    // The server's port is not the collision — two databases on one server
    // are two databases.
    expect(keys("psql postgresql://localhost/acme_test -c 'select 1'")).toEqual(["postgres localhost:5432/acme_test"]);
    expect(keys("REDIS_URL=redis://:pw@localhost:6380/2 bun worker.ts")).toEqual(["redis localhost:6380/2"]);
    expect(keys("redis-cli -u redis://localhost")).toEqual(["redis localhost:6379/0"]);
  });

  test("sqlite files, sockets and data dirs resolve against the command's cwd", () => {
    expect(keys("sqlite3 ../shared/app.db '.tables'", "/work/orbit")).toEqual(["sqlite /work/shared/app.db"]);
    expect(keys("cd /srv/data && sqlite3 cache.sqlite3 vacuum", "/work/orbit")).toEqual(["sqlite /srv/data/cache.sqlite3"]);
    expect(keys("bun seed.ts --db=/var/tmp/acme.sqlite")).toEqual(["sqlite /var/tmp/acme.sqlite"]);
    expect(keys("psql -h /var/run/postgresql/.s.PGSQL.5432")).toEqual(["socket /var/run/postgresql/.s.PGSQL.5432"]);
    expect(keys("curl --unix-socket /tmp/acme.sock http://x/")).toEqual(["socket /tmp/acme.sock"]);
    expect(keys("pg_ctl -D ~/pgdata start")).toEqual([`datadir ${join(homedir(), "pgdata")}`]);
    expect(keys("redis-server --dir /var/tmp/redis --port 6390")).toEqual(["datadir /var/tmp/redis", "port 6390"]);
  });

  test(".env files by path, never a property or a virtualenv", () => {
    expect(keys("cat ../.env")).toEqual(["env /work/.env"]);
    expect(keys("source /work/.env.local && bun dev")).toEqual(["env /work/.env.local"]);
    expect(keys("docker compose --env-file=../.env up", "/work/orbit")).toContain("env /work/.env");
    expect(keys("source .venv/bin/activate")).toEqual([]);
    expect(keys("bun -e 'console.log(process.env.HOME)'")).toEqual([]);
  });

  test("compose project: explicit name, env, directory, or the cwd's basename", () => {
    expect(keys("docker compose up -d", "/work/wt-a/Orbit.App")).toEqual(["compose orbitapp"]);
    expect(keys("docker compose -p acme up -d")).toEqual(["compose acme"]);
    expect(keys("docker-compose --project-name=acme down")).toEqual(["compose acme"]);
    expect(keys("COMPOSE_PROJECT_NAME=acme docker compose up")).toEqual(["compose acme"]);
    expect(keys("docker compose -f deploy/compose.yml up", "/work/orbit")).toEqual(["compose deploy"]);
    expect(keys("cd infra && docker compose up", "/work/orbit")).toEqual(["compose infra"]);
    // -p after the subcommand publishes a port, it does not name the project.
    expect(keys("docker compose run -p 3001:3000 web", "/work/orbit")).toEqual(["compose orbit", "port 3001"]);
  });

  test("a relative path with no cwd, a variable or a glob is not guessed", () => {
    expect(keys("sqlite3 app.db", null)).toEqual([]);
    expect(keys("sqlite3 $DB_FILE")).toEqual([]);
    expect(keys("rm -f /tmp/*.sqlite")).toEqual([]);
    expect(keys("docker compose up", null)).toEqual([]);
  });
});

describe("claimsFromPath", () => {
  test("only the resources a file tool can touch", () => {
    expect(col.claimsFromPath("/work/.env").map((c) => c.kind)).toEqual(["env"]);
    expect(col.claimsFromPath("/work/orbit/data/app.db").map((c) => c.kind)).toEqual(["sqlite"]);
    expect(col.claimsFromPath("/work/orbit/src/index.ts")).toEqual([]);
  });
});

const who = (source_app: string, session_id: string, root: string, claims: ReturnType<typeof col.claimsFromCommand>) =>
  ({ source_app, session_id, root, claims: claims.map((c) => ({ ...c, ts: now, via: "command" as const, evidence: c.key })) });

describe("findCollisions", () => {
  test("two checkouts on one resource collide; one checkout with itself does not", () => {
    const out = col.findCollisions([
      who("orbit", "aaaa1111", "/work/wt-a", col.claimsFromCommand("PORT=3000 bun dev", "/work/wt-a")),
      who("orbit", "bbbb2222", "/work/wt-b", col.claimsFromCommand("curl localhost:3000", "/work/wt-b")),
      who("orbit", "cccc3333", "/work/wt-c", col.claimsFromCommand("PORT=3001 bun dev", "/work/wt-c")),
      who("orbit", "dddd4444", "/work/wt-c", col.claimsFromCommand("curl localhost:3001", "/work/wt-c")),
    ]);
    expect(out.map((c) => c.resource)).toEqual(["port 3000"]);
    expect(out[0].parties.map((s) => s.session_id).sort()).toEqual(["aaaa1111", "bbbb2222"]);
  });

  test("an .env inside the claimant's own tree is its own, not shared", () => {
    const out = col.findCollisions([
      who("orbit", "aaaa1111", "/work/wt-a", col.claimsFromCommand("cat /work/wt-a/.env", "/work/wt-a")),
      who("orbit", "bbbb2222", "/work/wt-b", col.claimsFromCommand("cat /work/wt-a/.env", "/work/wt-b")),
    ]);
    expect(out).toEqual([]);
    const above = col.findCollisions([
      who("orbit", "aaaa1111", "/work/wt-a", col.claimsFromCommand("cat ../.env", "/work/wt-a")),
      who("orbit", "bbbb2222", "/work/wt-b", col.claimsFromCommand("cat ../.env", "/work/wt-b")),
    ]);
    expect(above.map((c) => c.resource)).toEqual(["env /work/.env"]);
  });
});

describe("getCollisions", () => {
  const ev = (session_id: string, at: number, hook: string, tool: string | null, input: Record<string, unknown>, cwd: string) => ({
    source_app: "orbit",
    session_id,
    hook_event_type: hook,
    tool_name: tool,
    tool_use_id: null,
    agent_id: null,
    agent_type: null,
    model_name: "claude-opus-4-8",
    is_error: 0,
    error_text: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
    usage_is_cumulative: false,
    summary: "",
    timestamp: at,
    payload: { cwd, tool_input: input },
    chat: null,
  });

  test("live sessions in two checkouts on one database are flagged; ended and stale ones are not", () => {
    const url = "DATABASE_URL=postgres://localhost:5432/acme_dev bunx prisma migrate dev";
    db.insertEvent(ev("live-a", now - 60_000, "PreToolUse", "Bash", { command: url }, "/work/wt-a") as any);
    // A Stop ends a turn, not a session: the one sitting at its prompt still counts.
    db.insertEvent(ev("live-a", now - 50_000, "Stop", null, {}, "/work/wt-a") as any);
    db.insertEvent(ev("live-b", now - 30_000, "PreToolUse", "Bash", { command: url }, "/work/wt-b") as any);
    db.insertEvent(ev("gone-c", now - 40_000, "PreToolUse", "Bash", { command: url }, "/work/wt-c") as any);
    db.insertEvent(ev("gone-c", now - 20_000, "SessionEnd", null, {}, "/work/wt-c") as any);
    db.insertEvent(ev("stale-d", now - 3 * 60 * 60_000, "PreToolUse", "Bash", { command: url }, "/work/wt-d") as any);
    db.insertEvent(ev("live-e", now - 10_000, "PreToolUse", "Read", { file_path: "/work/wt-e/README.md" }, "/work/wt-e") as any);

    const out = col.getCollisions(now, () => []);
    expect(out.map((c) => c.resource)).toEqual(["postgres localhost:5432/acme_dev"]);
    expect(out[0].parties.map((s) => s.session_id).sort()).toEqual(["live-a", "live-b"]);
    expect(out[0].parties.find((s) => s.session_id === "live-b")?.checkout).toBe("/work/wt-b");
  });

  test("a port a process is listening on counts for the checkout it runs in", () => {
    db.insertEvent(ev("live-f", now - 10_000, "PreToolUse", "Bash", { command: "bun test" }, "/work/wt-f") as any);
    db.insertEvent(ev("live-g", now - 10_000, "PreToolUse", "Bash", { command: "curl -s localhost:5555/api" }, "/work/wt-g") as any);
    const out = col.getCollisions(now, () => [{ port: 5555, addr: "127.0.0.1", pid: 4242, proc: "bun", cwd: "/work/wt-f/web" }]);
    const hit = out.find((c) => c.resource === "port 5555");
    expect(hit).toBeDefined();
    expect(hit!.parties.map((s) => `${s.session_id}:${s.via}`).sort()).toEqual(["live-f:listening", "live-g:command"]);
  });
});
