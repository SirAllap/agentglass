/*
 * The shapes the queue is built from, against a real server.
 *
 * This exists because of a bug that a type-check and a bundle both passed and
 * a phone did not: the app asked `/sessions` for `{ sessions: [...] }` and the
 * server answers the array itself. `buildQueue` then reached a `for…of` over
 * `undefined` and threw "Cannot convert undefined value to object", which is
 * not a missing card — it is a render error that takes the whole app down.
 *
 * The lesson is narrow and worth encoding: a TypeScript annotation on a
 * `fetch` is a claim about the server, checked by nobody. So this boots the
 * real one and reads the three routes the Now screen depends on, then runs the
 * dashboard's own `buildQueue` over the result. An empty machine is enough —
 * the mistake was about the WRAPPER, and `[]` and `{sessions: []}` differ just
 * as clearly when there is nothing in them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQueue } from "../src/model/nowQueue.ts";

const PORT = 4921;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = "a-machine-token-for-shapes";

let server: ReturnType<typeof Bun.spawn> | null = null;
let dir = "";

const get = async <T,>(path: string): Promise<T> => {
  const response = await fetch(ORIGIN + path, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-shapes-"));
  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: join(import.meta.dir, "..", "..", "server"),
    env: {
      ...process.env,
      AGENTGLASS_PORT: String(PORT),
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_DB: join(dir, "shapes.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      XDG_CONFIG_HOME: dir,
      /*
       * The server sweeps tmux window sizes at boot, over every socket in
       * `$TMUX_TMPDIR/tmux-<uid>`. Unset, that is `/tmp/tmux-<uid>` — the
       * developer's own tmux, sessions and all — and a `resize-window -A` on
       * one of their windows is what comes out the other end. Its own
       * directory, empty, like the database and the config above.
       */
      TMUX_TMPDIR: join(dir, "tmux"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${ORIGIN}/health`)).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  throw new Error(`the server never answered ${ORIGIN}/health`);
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("what the Now screen reads", () => {
  test("gates come wrapped", async () => {
    const body = await get<{ gates: unknown }>("/gate/pending");
    expect(Array.isArray(body.gates)).toBe(true);
  });

  test("sessions come BARE — the one that was got wrong", async () => {
    const body = await get<unknown>("/sessions?limit=100");
    expect(Array.isArray(body)).toBe(true);
    // Stated as its own assertion so a future wrapper shows up as this line
    // rather than as an empty queue nobody can explain.
    expect((body as { sessions?: unknown }).sessions).toBeUndefined();
  });

  test("containers come wrapped", async () => {
    const body = await get<{ containers: unknown; available: unknown }>("/docker/overview");
    expect(Array.isArray(body.containers)).toBe(true);
    expect(typeof body.available).toBe("boolean");
  });

  test("and the queue builds from all three without throwing", async () => {
    /*
     * The end of the path, which is what actually broke. `buildQueue` is the
     * dashboard's, iterating every list it is handed — so feeding it what the
     * server really said is the check that a type annotation cannot make.
     */
    const [gates, sessions, docker] = await Promise.all([
      get<{ gates: never[] }>("/gate/pending"),
      get<never[]>("/sessions?limit=100"),
      get<{ containers: never[] }>("/docker/overview"),
    ]);

    const queue = buildQueue({
      gates: gates.gates,
      sessions,
      prs: [],
      containers: docker.containers,
      me: "",
      now: Date.now(),
    });
    expect(Array.isArray(queue)).toBe(true);
  });

  test("a theme is null before anybody picks one, rather than a guess", async () => {
    // The other route the app reads on every foreground. Null and a palette
    // have to stay distinguishable, or the phone cannot tell whether it is
    // following the computer or falling back to what it ships.
    const body = await get<{ theme: unknown }>("/theme/current");
    expect(body.theme).toBeNull();
  });
});
