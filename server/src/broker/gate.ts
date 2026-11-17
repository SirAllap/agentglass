// Imported by the server's entry point right after relay/gate.ts, for the same
// reason and by the same means: in the broker role the rest of the entry point
// must never load, so the database is not opened, no timer starts, and the
// process stays a few megabytes (which is the whole point of it: see wire.ts).
// A top-level await in a dependency holds back every import that follows it.
// In any other role this does nothing.
if (process.env.AGENTGLASS_BROKER_CHILD === "1") {
  const { run } = await import("./brokerMain.ts");
  await run();
}
export {};
