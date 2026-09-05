/*
 * How long a hook that starts a real server is allowed to take.
 *
 * Twenty `beforeAll` hooks in this suite spawn `server/src/index.ts` and then
 * poll `/health` in a retry loop — `for (let i = 0; i < 150; i++) { ...
 * Bun.sleep(100) }`, which is fifteen seconds of declared patience. Bun gives a
 * hook FIVE by default, so the loop could never finish: the hook was killed at
 * a third of the wait its own code asks for, and the file reports
 * "a beforeEach/afterEach hook timed out" with zero tests run.
 *
 * That reads as a flake, and it was found as one — `browser-cli-ownership`
 * failing on its own while passing in the suite. Measured on an idle machine,
 * every one of the twenty comes up fast:
 *
 *     browser-cli-ownership   1,496 ms      the one that failed
 *     gate-actor-route        2,274 ms      the slowest hook of the twenty
 *     the other eighteen      196-497 ms
 *
 * So the retry loops are not covering a slow boot; they are covering a
 * CONTENDED one, and that is exactly when the five-second ceiling bites. Three
 * hypotheses were measured and refuted first — a cold worktree that had never
 * built the server (1,500 ms on its first run), a socket directory holding 301
 * dead sockets (1,591 ms), and four processes pinning the CPU (1,697 ms). What
 * remained was a second `make check` running beside it, which is the ordinary
 * state of this machine and cannot be reproduced without doing it to somebody.
 *
 * The number is the loops' own, not a bigger guess: what each hook waits for is
 * now what it is allowed to wait for. A hook that genuinely hangs still fails,
 * fifteen seconds later instead of five.
 */
export const SERVER_BOOT_MS = 30_000;
