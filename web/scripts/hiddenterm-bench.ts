/**
 * What a terminal nobody can see costs, measured with the real xterm parser.
 *
 *   cd web && bun scripts/hiddenterm-bench.ts
 *   HT_HIDDEN=6 HT_SECONDS=10 bun scripts/hiddenterm-bench.ts
 *
 * HT_HIDDEN terminals (default 3) are fed fake agent output (a spinner redraw
 * plus coloured lines, 3000 bytes every 16 ms each, like a busy agent TUI)
 * through the app's own web/src/lib/hiddenWrites.ts, the way TerminalPanel's
 * writeOut does. Modes:
 *   live  every chunk goes to xterm as it arrives (a hidden view before the hold).
 *   held  chunks wait in a WriteHold and go to xterm when the view is shown.
 * Reported per mode:
 *   cpuMs       process CPU while output flows (xterm parse is the bulk of it);
 *   writes      term.write calls during the flow;
 *   drawFrames  16 ms frames in which a hidden terminal's buffer changed. In a
 *               page each is one xterm render, because `visibility:hidden` still
 *               counts as on screen to xterm (no DOM here, so counted, not drawn);
 *   lagMaxMs    the worst delay of the 16 ms feed timer (the loop being busy);
 *   showMs      from the view coming back to every terminal being current;
 *   sameAsLive  every terminal ends with exactly the text of one fed live.
 * No server, no tmux, no window, no browser: xterm's core runs headless in bun.
 */
(globalThis as any).window ??= globalThis;
(globalThis as any).navigator ??= { userAgent: "bun", platform: "Linux" };
const { Terminal } = await import("@xterm/xterm");
const { holdRelease, holdStart, holdTake, newWriteHold } = await import("../src/lib/hiddenWrites.ts");
type Term = InstanceType<typeof Terminal>;

const HIDDEN = Number(process.env.HT_HIDDEN ?? 3);
const SECONDS = Number(process.env.HT_SECONDS ?? 8);
const CHUNK = 3000, EVERY = 16;

function agentChunk(n: number): Uint8Array {
  let s = `\x1b[s\x1b[1;1H\x1b[2K\x1b[38;5;${(n % 200) + 20}m✻ Working… ${n}\x1b[0m\x1b[u`;
  for (let i = 0; s.length < CHUNK; i++) s += `\x1b[3${i % 8}m${n}.${i} ${"lorem ipsum dolor sit amet ".repeat(2)}\x1b[0m\r\n`;
  return new TextEncoder().encode(s.slice(0, CHUNK));
}
// Made before the clock starts, so the feed itself costs nothing measured.
const POOL = Array.from({ length: 256 }, (_, n) => agentChunk(n));
const make = () => new Terminal({ cols: 100, rows: 24, scrollback: 5000, allowProposedApi: true });
const flushed = (t: Term) => new Promise<void>((r) => t.write("", r));
const text = (t: Term) => {
  const b = t.buffer.active, out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  return out.join("\n");
};
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

async function run(mode: "live" | "held") {
  const terms = Array.from({ length: HIDDEN }, make);
  const holds = terms.map(() => newWriteHold());
  if (mode === "held") holds.forEach(holdStart);
  let writes = 0, drawFrames = 0, lagMax = 0, n = 0;
  const changed = new Set<number>();
  terms.forEach((t, i) => t.onWriteParsed(() => changed.add(i)));
  const c0 = cpu(), t0 = performance.now();
  let last = t0;
  await new Promise<void>((done) => {
    const id = setInterval(() => {
      const now = performance.now();
      lagMax = Math.max(lagMax, now - last - EVERY); last = now;
      drawFrames += changed.size; changed.clear();
      if (now - t0 >= SECONDS * 1000) { clearInterval(id); done(); return; }
      const c = POOL[n++ % POOL.length]!;
      terms.forEach((t, i) => { for (const w of holdTake(holds[i]!, c)) { t.write(w); writes++; } });
    }, EVERY);
  });
  await Promise.all(terms.map(flushed));
  const cpuMs = Math.round(cpu() - c0);
  const s0 = performance.now();
  terms.forEach((t, i) => { for (const w of holdRelease(holds[i]!)) t.write(w); });
  await Promise.all(terms.map(flushed));
  const showMs = Math.round(performance.now() - s0);
  const ref = make();
  for (let k = 0; k < n; k++) ref.write(POOL[k % POOL.length]!);
  await flushed(ref);
  const want = text(ref);
  return { mode, mbFed: +((n * CHUNK * HIDDEN) / 1048576).toFixed(2), cpuMs, writes, drawFrames, lagMaxMs: Math.round(lagMax), showMs, sameAsLive: terms.every((t) => text(t) === want) };
}

const runs = [];
for (const mode of ["live", "held"] as const) runs.push(await run(mode));
console.log(JSON.stringify({ hidden: HIDDEN, seconds: SECONDS, bytesPerChunk: CHUNK, everyMs: EVERY }));
for (const r of runs) console.log(JSON.stringify(r));
process.exit(0);
