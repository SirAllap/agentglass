// Must be the FIRST import of the server's entry point. In the relay role it
// runs the relay and never lets the rest of the entry point load, so the
// database is not opened and none of the server's timers start: a top-level
// await in a dependency holds back every import that follows it. In any other
// role it does nothing. A second role of the same file is how the relay ships
// inside the compiled single-file server (`bun build --compile`), where there
// is no second script to start (spiked: works under `bun run` and compiled).
if (process.env.AGENTGLASS_RELAY_CHILD === "1") {
  const { run } = await import("./termrelay.ts");
  await run();
}
export {};
