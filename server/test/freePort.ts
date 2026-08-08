// A port the operating system says is free, instead of one a die picked.
//
// Ten test files spawned a real server, and every one chose its port the same
// way: a literal base plus `Math.random()` over a narrow span. The spans
// overlapped — 4930+60 covers 4930-4989 and 4960+20 covers 4960-4979 — and
// `bun test` runs the files concurrently, so two servers regularly rolled the
// same number.
//
// The failure that produces is worse than a bind error, which is why it took a
// while to see. The loser of the race does not crash: it fails to bind, and the
// readiness loop then polls `/health` and gets a cheerful `{"ok":true,
// "service":"agentglass"}` — from the OTHER test's server, which is a real
// agentglass and cannot be told apart by that route. The file then drives
// somebody else's process, whose tmux socket, database and root directory are
// all different, and one assertion somewhere fails. Intermittently, in a
// different file each run, and never when that file is run on its own.
//
// Asking for port 0 makes the kernel hand back something nothing is bound to.
// The listener is closed before the number is returned, so there is a window in
// which another process could take it — but that is a few milliseconds against
// test servers that live for seconds, rather than a one-in-twenty coin flip on
// every run.
//
// `Bun.serve` rather than `node:net`: it is what the code under test uses, so
// "free" is decided by the same stack that will do the binding.

/** Bind :0 on loopback, note what the kernel chose, release it. */
export async function freePort(): Promise<number> {
  // Loopback rather than every interface, because the servers under test bind
  // 127.0.0.1 and a port is only ever free per-address.
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const { port } = s;
  await s.stop(true);
  // Typed optional because a unix-socket server has no port. This one asked for
  // a TCP one, so a miss here is the kernel refusing, not a shape to paper over.
  if (port === undefined) throw new Error("Bun.serve bound no TCP port");
  return port;
}
