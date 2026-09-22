/*
 * Two checkouts can each be green and still share the one thing neither diff
 * contains: a dev server's port, a database, an .env above both trees, a
 * compose project. These cases pin what the detector reads out of a command,
 * what it will and will not call a collision, and that a session which has
 * ended or gone quiet stops counting.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-collisions-"));
const priorDb = process.env.AGENTGLASS_DB;
process.env.AGENTGLASS_DB = join(dir, "collisions.db");
delete process.env.AGENTGLASS_ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let col: typeof import("../src/collisions.ts");
const now = Date.now();
const machineSrc = await Bun.file(join(import.meta.dir, "../src/machine.ts")).text();

beforeAll(async () => {
  db = await import("../src/db.ts");
  col = await import("../src/collisions.ts");
});
afterAll(() => {
  if (priorDb === undefined) delete process.env.AGENTGLASS_DB;
  else process.env.AGENTGLASS_DB = priorDb;
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

  test("a wrapper in front of the program is looked through", () => {
    // The second checkout's server fails to bind, so its command is the only
    // evidence it is a party; a wrapper must not hide it.
    expect(keys("npx cross-env PORT=3000 next dev")).toEqual(["port 3000"]);
    expect(keys("sudo PORT=8080 node server.js")).toEqual(["port 8080"]);
    expect(keys("time PORT=3001 npm start")).toEqual(["port 3001"]);
    expect(keys("nohup env PORT=3002 node app.js &")).toEqual(["port 3002"]);
    expect(keys("dotenv -e .env.test -- PORT=3003 bun dev")).toEqual(["env /work/orbit/.env.test", "port 3003"]);
    // ...and so is a client, wrapped or run inside a container.
    expect(keys("sudo psql -p 5433 -d acme")).toEqual([]);
    expect(keys("docker exec -it pg psql -p 5433 -d acme")).toEqual([]);
    expect(keys("sudo -u postgres git log -p")).toEqual([]);
  });

  test("text gates database URLs and compose too; an ssh forward binds a local port", () => {
    expect(keys('git commit -m "point at postgres://localhost:5432/acme_dev"')).toEqual([]);
    expect(keys("echo redis://localhost:6379/2")).toEqual([]);
    expect(keys("echo docker compose up -d >> README.md")).toEqual([]);
    expect(keys("ssh -N -L 5433:localhost:5432 bastion")).toEqual(["port 5433"]);
    expect(keys("ssh -L127.0.0.1:6380:cache:6379 bastion")).toEqual(["port 6380"]);
  });

  test("text that mentions a port or a database file is not a process using one", () => {
    // Agents grep for ports and write them into commit messages all the time;
    // each claim would last the whole window and flag both checkouts.
    expect(keys('git commit -m "serve on PORT=3000 and localhost:8080"')).toEqual([]);
    expect(keys("grep -rn localhost:3000 README.md")).toEqual([]);
    expect(keys('gh pr create --title "Dev server" --body "open localhost:3000"')).toEqual([]);
    expect(keys('echo "PORT=3000" | tee notes.txt')).toEqual([]);
    expect(keys("git diff HEAD~1 -- prisma/dev.db")).toEqual([]);
    expect(keys("echo x > out.db")).toEqual([]);
    // A heredoc body is text too, whatever its lines start with — the usual
    // shape of a commit message written by an agent.
    expect(keys("git commit -F - <<'EOF'\nfix: serve on localhost:3000\nPORT=3001 is the other one\nEOF")).toEqual([]);
    expect(keys('git commit -m "$(cat <<EOF\nuse localhost:3000\nEOF\n)" && PORT=3002 bun dev')).toEqual(["port 3002"]);
    // A multi-line quoted message is one argument, not one command per line —
    // the way commit messages and PR bodies are written without a heredoc.
    expect(keys('git commit -m "fix(dev): pick a free port\n\nThe server on localhost:3000 now falls back."')).toEqual([]);
    expect(keys('gh pr create --body "## Testing\n- PORT=5173 npm run dev\n- sqlite3 dev.db"')).toEqual([]);
    expect(keys('git commit -m "a; b" && PORT=3006 bun dev')).toEqual(["port 3006"]);
    // Only a real heredoc opener hides what follows it.
    expect(keys("x=$((1<<8))\nPORT=3007 npm run dev")).toEqual(["port 3007"]);
    expect(keys('echo "a << b"\nPORT=3008 npm run dev')).toEqual(["port 3008"]);
    expect(keys("cat <<END-OF-MSG\nhello\nEND-OF-MSG\nPORT=3009 npm run dev")).toEqual(["port 3009"]);
    expect(keys("cat <<\\EOF\ncurl localhost:4000\nEOF")).toEqual([]);
    // Reading an .env above the tree is still reading it.
    expect(keys("grep API_URL ../.env")).toEqual(["env /work/.env"]);
    // A port a process is started with still counts, as does one it is asked to reach.
    expect(keys("export PORT=3003")).toEqual(["port 3003"]);
    expect(keys("env PORT=3004 bun dev")).toEqual(["port 3004"]);
    expect(keys("bun run dev -- --port 3005")).toEqual(["port 3005"]);
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
    // docker's own flags may come before the subcommand.
    expect(keys("docker --context dev compose up -d", "/work/orbit")).toEqual(["compose orbit"]);
    expect(keys("docker --log-level=warn -c dev compose -p acme up")).toEqual(["compose acme"]);
  });

  test("a relative path with no cwd, a variable or a glob is not guessed", () => {
    expect(keys("sqlite3 app.db", null)).toEqual([]);
    expect(keys("sqlite3 $DB_FILE")).toEqual([]);
    expect(keys("rm -f /tmp/*.sqlite")).toEqual([]);
    expect(keys("docker compose up", null)).toEqual([]);
  });
});

describe("maskEvidence", () => {
  test("credentials in a command never reach the evidence shown", () => {
    const cases = [
      "curl -u admin:s3cr3t http://localhost:3000/ -H 'Authorization: Bearer abc.def'",
      "curl --user=admin:s3cr3t localhost:3000 -H \"authorization: token abc.def\"",
      "mysql -uroot -ps3cr3t -P 3306 acme",
      "pg_dump --password=s3cr3t acme",
      "DATABASE_URL=postgres://app:s3cr3t@localhost/acme bun dev",
      "API_TOKEN=abc.def bun dev",
      'curl -u "admin:s3cr3t" http://localhost:3000/',
      "curl --user 'admin:s3cr3t' localhost:3000",
      'curl -H "X-Api-Key: abc.def" -H "PRIVATE-TOKEN: abc.def" -H "Cookie: session=abc.def" localhost:3000',
      "STRIPE_KEY=abc.def SENDGRID_KEY=s3cr3t bun dev",
      "redis-cli -a s3cr3t -p 6379 ping",
      "mongosh -u admin -p s3cr3t",
      "sshpass -p s3cr3t ssh build@ci",
      'mysql --password "s3cr3t" acme',
      "psql postgres://app:Zm9v/s3cr3t@localhost:5432/acme_dev",
      "psql postgres://app:p@s3cr3t@localhost/acme",
    ];
    for (const c of cases) {
      const out = col.maskEvidence(c);
      expect(out).not.toContain("s3cr3t");
      expect(out).not.toContain("abc.def");
    }
    // What is not a secret stays readable.
    expect(col.maskEvidence("curl -u admin:s3cr3t http://localhost:3000/")).toContain("localhost:3000");
    expect(col.maskEvidence("docker run -p 8080:80 nginx")).toBe("docker run -p 8080:80 nginx");
    expect(col.maskEvidence("mkdir -p dist")).toBe("mkdir -p dist");
    expect(col.maskEvidence("docker run -u 1000:1000 -p8080:80 app")).toBe("docker run -u 1000:1000 -p8080:80 app");
    expect(col.maskEvidence('git commit -m "Use bearer auth in the client"')).toBe('git commit -m "Use bearer auth in the client"');
    expect(col.maskEvidence("mysql acme < dump.sql && find . -print -prune")).toBe("mysql acme < dump.sql && find . -print -prune");
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

  test("a sibling whose name starts with the checkout's is not inside it", () => {
    const out = col.findCollisions([
      who("orbit", "aaaa1111", "/work/wt-a", col.claimsFromCommand("cat /work/wt-a-shared/.env", "/work/wt-a")),
      who("orbit", "bbbb2222", "/work/wt-b", col.claimsFromCommand("cat /work/wt-a-shared/.env", "/work/wt-b")),
    ]);
    expect(out.map((c) => c.resource)).toEqual(["env /work/wt-a-shared/.env"]);
  });
});

describe("getCollisions", () => {
  // Real checkouts: a session counts only inside one.
  const W = join(dir, "work");
  for (const wt of ["wt-a", "wt-b", "wt-c", "wt-d", "wt-e", "wt-f", "wt-g"]) mkdirSync(join(W, wt, ".git"), { recursive: true });
  // db.ts is one module for the whole `bun test` process, so the events table
  // holds whatever any other file inserted near `now`. Only this file's
  // sessions are read back.
  const ours = (out: Awaited<ReturnType<typeof col.getCollisions>>, ids: string[]) =>
    out
      .map((c) => ({ ...c, parties: c.parties.filter((p) => ids.includes(p.session_id)) }))
      .filter((c) => c.parties.length > 0);
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

  test("live sessions in two checkouts on one database are flagged; ended and stale ones are not", async () => {
    const url = "DATABASE_URL=postgres://app:hunter2@localhost:5432/acme_dev bunx prisma migrate dev";
    db.insertEvent(ev("live-a", now - 60_000, "PreToolUse", "Bash", { command: url }, `${W}/wt-a`) as any);
    // A Stop ends a turn, not a session: the one sitting at its prompt still counts.
    db.insertEvent(ev("live-a", now - 50_000, "Stop", null, {}, `${W}/wt-a`) as any);
    db.insertEvent(ev("live-b", now - 30_000, "PreToolUse", "Bash", { command: url }, `${W}/wt-b`) as any);
    db.insertEvent(ev("gone-c", now - 40_000, "PreToolUse", "Bash", { command: url }, `${W}/wt-c`) as any);
    db.insertEvent(ev("gone-c", now - 20_000, "SessionEnd", null, {}, `${W}/wt-c`) as any);
    db.insertEvent(ev("stale-d", now - 3 * 60 * 60_000, "PreToolUse", "Bash", { command: url }, `${W}/wt-d`) as any);
    db.insertEvent(ev("live-e", now - 10_000, "PreToolUse", "Read", { file_path: `${W}/wt-e/README.md` }, `${W}/wt-e`) as any);

    const out = ours(await col.getCollisions(now, () => []), ["live-a", "live-b", "gone-c", "stale-d", "live-e"]);
    expect(out[0].parties.find((s) => s.session_id === "live-b")?.evidence).toBe("DATABASE_URL=postgres://…@localhost:5432/acme_dev bunx prisma migrate dev");
    expect(out.map((c) => c.resource)).toEqual(["postgres localhost:5432/acme_dev"]);
    expect(out[0].parties.map((s) => s.session_id).sort()).toEqual(["live-a", "live-b"]);
    expect(out[0].parties.find((s) => s.session_id === "live-b")?.checkout).toBe(`${W}/wt-b`);
  });

  test("a port a process is listening on counts for the checkout it runs in", async () => {
    db.insertEvent(ev("live-f", now - 10_000, "PreToolUse", "Bash", { command: "bun test" }, `${W}/wt-f`) as any);
    db.insertEvent(ev("live-g", now - 10_000, "PreToolUse", "Bash", { command: "curl -s localhost:5555/api" }, `${W}/wt-g`) as any);
    const out = ours(await col.getCollisions(now, () => [{ port: 5555, addr: "127.0.0.1", pid: 4242, proc: "bun", cwd: `${W}/wt-f/web` }]), ["live-f", "live-g"]);
    const hit = out.find((c) => c.resource === "port 5555");
    expect(hit).toBeDefined();
    expect(hit!.parties.map((s) => `${s.session_id}:${s.via}`).sort()).toEqual(["live-f:listening", "live-g:command"]);
  });

  test("an OpenCode session counts: lowercase tools, filePath, project_path for its directory", async () => {
    // OpenCode's plugin sends `bash` and `read`, the path as `filePath`, and
    // its directory as `project_path` with no `cwd` — read as Claude's shape,
    // the session had no cwd and dropped out.
    const oc = (session_id: string, tool: string, input: Record<string, unknown>, project_path: string) =>
      ({ ...ev(session_id, now - 5_000, "PreToolUse", tool, input, ""), source_app: "opencode", payload: { project_path, tool_input: input } });
    db.insertEvent(oc("oc-k", "read", { filePath: `${W}/.env.shared` }, `${W}/wt-a`) as any);
    db.insertEvent(oc("oc-l", "bash", { command: "cat ../.env.shared" }, `${W}/wt-b`) as any);
    const out = ours(await col.getCollisions(now, () => []), ["oc-k", "oc-l"]);
    expect(out.map((c) => c.resource)).toEqual([`env ${W}/.env.shared`]);
    expect(out[0].parties.map((p) => `${p.session_id}:${p.via}`).sort()).toEqual(["oc-k:file", "oc-l:command"]);
  });

  test("a session outside any checkout is not a party, and a listener below it is nobody's", async () => {
    // A session sitting in the home directory has no checkout; taking the
    // directory itself as one made every dev server under it that session's,
    // and paired it with whichever agent curled the port.
    const home = join(dir, "home");
    mkdirSync(join(home, "code", "other"), { recursive: true });
    db.insertEvent(ev("home-h", now - 10_000, "PreToolUse", "Bash", { command: "ls" }, home) as any);
    db.insertEvent(ev("home-i", now - 10_000, "PreToolUse", "Bash", { command: "curl -s localhost:5556/" }, home) as any);
    db.insertEvent(ev("live-j", now - 10_000, "PreToolUse", "Bash", { command: "curl -s localhost:5556/" }, `${W}/wt-a`) as any);
    const out = ours(await col.getCollisions(now, () => [{ port: 5556, addr: "127.0.0.1", pid: 4343, proc: "node", cwd: join(home, "code", "other") }]), ["home-h", "home-i", "live-j"]);
    expect(out).toEqual([]);
    expect(col.checkoutOf(join(home, "code"))).toBeNull();
    expect(col.checkoutOf(`${W}/wt-a/src/deep`)).toBe(`${W}/wt-a`);
  });
});

describe("listeners on the dashboard poll", () => {
  // Fleet asks for collisions every 15 s from every open dashboard. The ss
  // behind it used to be a spawnSync that stopped the whole server for as long
  // as ss took, on every one of those polls.
  test("one load serves every caller for the window, concurrent ones included", async () => {
    let loads = 0;
    let t = 1_000_000;
    const get = col.cachedListeners(async () => { loads++; return []; }, 30_000, () => t);
    await Promise.all([get(), get(), get()]);
    expect(loads).toBe(1);
    t += 29_000;
    await get();
    expect(loads).toBe(1);
    t += 2_000;
    await get();
    expect(loads).toBe(2);
  });

  test("a failed load is not kept for the window", async () => {
    let loads = 0;
    const get = col.cachedListeners(async () => { loads++; throw new Error("ss hung"); }, 30_000, () => 0);
    expect(await get()).toEqual([]);
    expect(await get()).toEqual([]);
    expect(loads).toBe(2);
  });

  test("ss is spawned without blocking the event loop", () => {
    const start = machineSrc.indexOf("export async function listPortsAsync(");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = machineSrc.slice(start, machineSrc.indexOf("\n}\n", start));
    const code = body.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).toContain("Bun.spawn(");
    expect(code).not.toContain("spawnSync");
  });
});
