// The spawn broker process. A role of the server binary (see gate.ts) that
// starts processes for the main server and hands back what they said. It
// imports only the two wire files and bun built-ins, never db.ts and nothing
// of the server's graph: its fork is cheap because it is small, and it stays
// small only if nothing is loaded into it. What to run, with which limits, is
// decided in main; this process only does the fork, the waiting and the kill.
import { lineSplitter } from "../relay/wire.ts";
import { capped, envFor } from "./wire.ts";
import type { BrokerDone, FromBroker, ToBroker } from "./wire.ts";

type Run = Extract<ToBroker, { op: "run" }>;

export async function run(): Promise<never> {
  const live = new Map<number, ReturnType<typeof Bun.spawn>>();
  const sink = Bun.stdout.writer();
  // Every answer is owed: main is waiting on it. A full pipe (main stalled)
  // is waited out by the sink, which keeps what it was given.
  // Main gone (the pipe closed under a run that outlived it): the answer has no
  // reader, and failing to deliver it must not end the runs still going.
  const say = (m: FromBroker) => {
    try { sink.write(JSON.stringify(m) + "\n"); void Promise.resolve(sink.flush()).catch(() => {}); } catch { /* no reader */ }
  };
  const running = new Set<Promise<void>>();

  async function start(m: Run): Promise<void> {
    const done: BrokerDone = { id: m.id, code: null, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false, held: false };
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(m.argv, {
        cwd: m.cwd || undefined,
        env: envFor(process.env, m.env, m.unset),
        stdin: m.stdin === undefined ? "ignore" : new TextEncoder().encode(m.stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      say({ op: "done", ...done, error: String(e) });
      return;
    }
    live.set(m.id, proc);
    const out = capped(m.maxBytes);
    const err = capped(m.maxBytes);
    const drain = async (stream: unknown, into: ReturnType<typeof capped>) => {
      try { for await (const chunk of stream as AsyncIterable<Uint8Array>) into.push(chunk); } catch { /* closed under us */ }
    };
    const output = Promise.all([drain(proc.stdout, out), drain(proc.stderr, err), proc.exited]);
    output.catch(() => {});
    let gaveUp: (v: null) => void = () => {};
    const held = new Promise<null>((r) => { gaveUp = r; });
    let late: ReturnType<typeof setTimeout> | undefined;
    const kill = setTimeout(() => {
      done.timedOut = true;
      try { proc.kill(); } catch { /* already gone */ }
      // A grandchild can keep the pipe open long after the kill: see git.ts.
      if (m.graceMs !== undefined) late = setTimeout(() => gaveUp(null), m.graceMs);
    }, m.timeoutMs);
    const settled = await Promise.race([output, held]);
    clearTimeout(kill);
    clearTimeout(late);
    live.delete(m.id);
    if (!settled) {
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
      done.held = true;
    } else {
      done.code = settled[2];
    }
    done.signal = proc.signalCode ?? null;
    done.stdout = out.text();
    done.stderr = err.text();
    done.truncated = out.truncated || err.truncated;
    say({ op: "done", ...done });
  }

  const onLine = (line: string) => {
    let m: ToBroker;
    try { m = JSON.parse(line) as ToBroker; } catch { return; }
    if (m.op === "run") { const p = start(m); running.add(p); void p.finally(() => running.delete(p)); }
    else if (m.op === "kill") { try { live.get(m.id)?.kill(); } catch { /* gone */ } }
    else if (m.op === "ping") say({ op: "pong" });
  };

  say({ op: "ready" });
  const split = lineSplitter();
  const dec = new TextDecoder();
  // Main going away (a restart, an install, a crash) closes this pipe. What is
  // running is NOT killed: a direct spawn outlived the server too, and a
  // rebase, a push or a gh pr merge cut halfway leaves the repository worse
  // than one run to the end. Each still has its own limit and kill in start().
  for await (const chunk of Bun.stdin.stream()) for (const l of split(dec.decode(chunk, { stream: true }))) onLine(l);
  await Promise.allSettled([...running]);
  process.exit(0);
}
