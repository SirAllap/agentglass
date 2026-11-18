// Imported right after relay/gate.ts, before anything that opens the
// database. In the reader role it runs the reader and never lets the rest of
// the entry point load: db.ts would open the file for writing, run the schema
// and start the server's timers, and the reader exists to be none of that.
// In any other role it does nothing. Same mechanism as the terminal relay: a
// further role of the one compiled binary, where there is no second script.
if (process.env.AGENTGLASS_DBREADER_CHILD === "1") {
  const { run } = await import("./readerMain.ts");
  await run();
}
export {};
