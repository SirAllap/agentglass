/*
 * SQLite's auto-checkpoint ran inside a commit on the event loop and fsynced
 * there; under a test suite's disk load that was the loop's slow ticks. The
 * worker takes the routine checkpoint: this connection stops auto-checkpointing
 * only once the worker is up, and the worker really copies the WAL back.
 */
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { checkpointerPass, db, startCheckpointer, stopCheckpointer } from "../src/db.ts";

afterEach(stopCheckpointer);
afterAll(stopCheckpointer);

const auto = () => (db.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint;

test("the worker takes over the checkpoint and copies the WAL frames back", async () => {
  expect(auto()).toBe(1000);
  startCheckpointer(50);
  for (let i = 0; i < 100 && auto() !== 0; i++) await Bun.sleep(20);
  expect(auto()).toBe(0);

  db.exec("CREATE TABLE IF NOT EXISTS ckpt_probe (x TEXT)");
  const ins = db.prepare("INSERT INTO ckpt_probe VALUES (?)");
  for (let i = 0; i < 300; i++) ins.run("x".repeat(4000));
  const from = checkpointerPass().passes;
  // Auto-checkpoint is off here, so only the worker copies these frames.
  for (let i = 0; i < 100 && !(checkpointerPass().passes > from && checkpointerPass().copied >= 300); i++) await Bun.sleep(20);
  const p = checkpointerPass();
  expect(p.copied).toBeGreaterThanOrEqual(300);
  expect(p.copied).toBe(p.log);
});

// A fake worker: says it is up, then breaks. `pass` is what each interval does.
const fake = (pass: string) => `self.onmessage = (e) => { postMessage({ ready: true }); setInterval(() => { ${pass} }, e.data.every); };`;

async function brokenWorkerFallsBack(pass: string) {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const start = checkpointerPass();
    startCheckpointer(20, fake(pass));
    for (let i = 0; i < 100 && auto() !== 0; i++) await Bun.sleep(5);
    expect(auto()).toBe(0);
    // The worker is broken: auto-checkpoint must come back.
    for (let i = 0; i < 200 && auto() !== 1000; i++) await Bun.sleep(5);
    expect(auto()).toBe(1000);
    expect(checkpointerPass().failures).toBeGreaterThan(start.failures);
    // Then a new worker, which fails again; the log line is said only once.
    for (let i = 0; i < 300 && checkpointerPass().restarts < start.restarts + 2; i++) await Bun.sleep(5);
    expect(checkpointerPass().restarts).toBeGreaterThanOrEqual(start.restarts + 2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("checkpoint worker failed")).length).toBe(1);
  } finally { warn.mockRestore(); }
}

test("a worker that errors on every pass: auto-checkpoint back on, one log line, a restart", async () => {
  await brokenWorkerFallsBack(`postMessage({ error: "SQLITE_IOERR" });`);
});

test("a worker that hangs: auto-checkpoint back on, one log line, a restart", async () => {
  await brokenWorkerFallsBack(``);
});

test("stopCheckpointer gives the checkpoint back to SQLite", async () => {
  startCheckpointer(50);
  for (let i = 0; i < 100 && auto() !== 0; i++) await Bun.sleep(20);
  expect(auto()).toBe(0);
  stopCheckpointer();
  expect(auto()).toBe(1000);
});

test("a huge WAL on a new worker's first report is not a failure; the second one is", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const start = checkpointerPass();
    // Every pass reports a WAL over the cap.
    startCheckpointer(20, fake(`postMessage({ busy: 0, log: 70000, copied: 0 });`));
    for (let i = 0; i < 100 && checkpointerPass().passes < start.passes + 1; i++) await Bun.sleep(5);
    expect(checkpointerPass().passes).toBeGreaterThanOrEqual(start.passes + 1);
    expect(checkpointerPass().failures).toBe(start.failures); // first report forgiven
    for (let i = 0; i < 100 && checkpointerPass().failures === start.failures; i++) await Bun.sleep(5);
    expect(checkpointerPass().failures).toBeGreaterThan(start.failures); // still huge: now it counts
  } finally { warn.mockRestore(); }
});
