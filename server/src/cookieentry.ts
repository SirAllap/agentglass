/**
 * `agentglass-server cookies …`, handled before anything else loads.
 *
 * The packaged app ships one executable — the compiled sidecar — so the one-shot
 * cookie reader has to be reachable through it. It cannot be a branch further
 * down index.ts: ESM evaluates every import first, and index.ts's imports open
 * the application database and start timers on the way past. So this module is
 * index.ts's FIRST import, and it exits the process before any of that runs.
 *
 * Nothing happens here for a normal boot.
 */
if (process.argv[2] === "cookies") {
  const { runCookieReader } = await import("./cookieread.ts");
  process.exit(await runCookieReader(process.argv.slice(3)));
}

export {};
