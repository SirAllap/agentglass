/*
 * THE READER: a second connection to the database, in a process of its own.
 *
 * The server asks for a read by name (reader/reads.ts) on this process's
 * stdin and awaits the answer on its stdout. When the database file is cold
 * the wait on the disk happens here, where it holds up nothing: measured on
 * the installed app, that wait was 2 to 4.5 s of the server's only thread.
 *
 * It can only read. `query_only` refuses any write on this connection, and
 * no code here or in reads.ts has one. It answers one request at a time: it
 * is a single thread too, and queueing here costs nobody else.
 *
 * Wire: one JSON object per line. In `{ id, fn, ctx, args }`, out
 * `{ id, ok: true, data }` or `{ id, ok: false, error }`, after one
 * `{ ready: true }`. It ends when its stdin does, which is when the server
 * is gone.
 *
 * Imports nothing from ../db.ts, directly or through reads.ts.
 */
import { Database } from "bun:sqlite";
import { lineSplitter } from "../relay/wire.ts";
import { READS, type ReadName } from "./reads.ts";

export type ReadRequest = { id: number; fn: string; ctx: unknown; args: unknown[] };
export type ReadAnswer = { id: number; ok: true; data: unknown } | { id: number; ok: false; error: string };

/** A connection that can only read. Small cache: the pages it wants are the OS's to keep, and a
 *  second process must not add to the memory pressure that makes the file cold in the first place. */
export function openReader(path: string): Database {
  const conn = new Database(path);
  conn.exec("PRAGMA query_only = 1;");
  conn.exec("PRAGMA busy_timeout = 2000;");
  conn.exec("PRAGMA cache_size = -8000;");
  return conn;
}

/** One request, answered. Never throws: an unknown name or a failed query is an answer too. */
export function answer(conn: Database, req: ReadRequest): ReadAnswer {
  const read = Object.prototype.hasOwnProperty.call(READS, req.fn) ? READS[req.fn as ReadName] : null;
  if (!read) return { id: req.id, ok: false, error: `unknown read: ${String(req.fn).slice(0, 80)}` };
  try { return { id: req.id, ok: true, data: read(conn, req.ctx, Array.isArray(req.args) ? req.args : []) }; }
  catch (e) { return { id: req.id, ok: false, error: String(e).slice(0, 500) }; }
}

export async function run(): Promise<never> {
  // Buffered without limit by the runtime, which the relay could not afford and this can: there is one
  // answer per request, and the server kills a reader it has stopped hearing from.
  const out = (o: unknown) => { process.stdout.write(JSON.stringify(o) + "\n"); };
  let conn: Database;
  try { conn = openReader(process.env.AGENTGLASS_DBREADER_PATH ?? ""); }
  catch (e) { console.error(`[dbreader] cannot open the database: ${String(e)}`); process.exit(2); }
  out({ ready: true });
  const split = lineSplitter();
  const dec = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of split(dec.decode(chunk, { stream: true }))) {
      let req: ReadRequest;
      try { req = JSON.parse(line) as ReadRequest; } catch { continue; }
      out(answer(conn, req));
    }
  }
  process.exit(0);
}
