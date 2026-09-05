/*
 * WHAT A CALLER IS TOLD WHEN SOMETHING THREW.
 *
 * `String(e)` reads like the honest thing to return and is not. A caught
 * exception carries the plumbing: absolute paths on this machine, the shape of
 * a directory tree, the argv of a command, sometimes a stack. None of that is
 * the caller's business, and on a machine reachable from a phone the caller is
 * not always the person sitting at it — CodeQL reads the same flow as
 * `js/stack-trace-exposure` and it is right to.
 *
 * The distinction this module draws is between a refusal and a failure.
 *
 * A REFUSAL is a decision this app made and can spell out: "that path is not
 * in the open project", "a note is text". Those sentences are written here, in
 * this repository, and they are exactly what the caller needs. They do not go
 * through this module at all — they are returned as themselves.
 *
 * A FAILURE is the other kind: the write threw, the command was not there, the
 * disk is full. The caller needs to know the operation did not happen, and
 * nothing else. The real error goes to this process's stderr, where the person
 * running the app can read it, and the caller gets a sentence naming what
 * failed in the app's own vocabulary.
 */

/**
 * Log the real error, return the sentence the caller gets.
 *
 * `where` is a short tag for the log line, so a maintainer reading stderr can
 * find the call site without a stack. `said` is the sentence, and it should
 * name the operation rather than the mechanism: "the note could not be saved",
 * not "writeFileSync failed".
 */
export function failed(where: string, e: unknown, said: string): string {
  console.error(`[${where}]`, e);
  return said;
}
