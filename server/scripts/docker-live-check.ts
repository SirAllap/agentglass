#!/usr/bin/env bun
/*
 * The Docker panel, against a real daemon.
 *
 * The unit tests cover the parsing and the rules; they cannot cover the thing
 * that actually breaks, which is docker itself not printing what the code
 * assumed. Both bugs this script was written to find were of exactly that kind
 * and neither was visible in a green suite:
 *
 *   - `docker system df -v` has no `Reclaimable` field at all, so the disk bar
 *     said "0 reclaimable" on a machine with 226GB of it;
 *   - the peek ran `ls --time-style=long-iso`, which busybox — i.e. alpine,
 *     i.e. the image it picks — does not have.
 *
 * Read-only. It starts one throwaway container to prove the volume peek and one
 * to prove the ownership ledger, both `--rm --network none`, and removes the
 * scratch volume afterwards. It changes nothing else and deletes nothing.
 *
 *     cd server && bun run scripts/docker-live-check.ts
 */
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disk, overview, volumePeek } from "../src/docker.ts";
import { streamLogs } from "../src/dockerlogs.ts";
import { __setLedgerPath, ledgerFor } from "../src/dockerledger.ts";
import { startVolumeWatch, stopVolumeWatch } from "../src/dockerwatch.ts";
import { humanSize } from "../../shared/dockerSize.ts";

const SCRATCH_VOLUME = "agx-live-check-vol";
let failed = 0;
const say = (pass: boolean, name: string, detail = "") => {
  if (!pass) failed++;
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

console.log("Docker panel — live checks\n");

/* 1. The poll, enriched. Everything here has to come out of ONE `docker ps`
      plus the batched inspect; if it is empty the enrichment is not wired. */
const t0 = Date.now();
const ov = await overview();
const pollMs = Date.now() - t0;
say(ov.available, "the daemon answers", `${ov.containers.length} containers in ${pollMs}ms, freshness=${ov.freshness}`);
say(pollMs < 3000, "the poll stays under three seconds", `${pollMs}ms`);
const ported = ov.containers.find((c) => c.portList?.length);
say(!!ported, "ports parsed off the poll", ported ? `${ported.name} ${ported.portList![0]!.host}→${ported.portList![0]!.container}` : "nothing published");
const owned = ov.containers.find((c) => c.owner);
say(!!owned, "the owning checkout resolved", owned ? `${owned.name} ← ${owned.owner!.worktree} (${owned.owner!.branch ?? "detached"})` : "no compose labels");
say(ov.containers.some((c) => c.startedAt), "the batched inspect filled in start times");

/* 2. Disk. The numbers have to agree with `docker system df`, because that is
      the command people will check them against. */
const d = await disk(true);
say(!!d && d.images > 0, "disk totals", d ? `images ${humanSize(d.images)} · cache ${humanSize(d.buildCache)}` : "null");
say(!!d && d.reclaimable > 0, "reclaimable is real", d ? humanSize(d.reclaimable) : "");
say(!!d && d.volumes_.length > 0, "per-volume sizes", `${d?.volumes_.length ?? 0} volumes`);
/* Every orphan is a delete this panel is about to offer. If one of them still
   has a checkout on disk, the offer is wrong and expensive. */
const { existsSync } = await import("node:fs");
const parent = join(process.env.HOME ?? "", "code");
const stillThere = (d?.orphans ?? []).filter((o) => existsSync(join(parent, o.worktree)));
say(stillThere.length === 0, "no 'orphan' still has a checkout", `${d?.orphans.length ?? 0} orphans, ${humanSize((d?.orphans ?? []).reduce((n, o) => n + (o.bytes ?? 0), 0))}`);

/* 3. A look inside a real volume, with whatever image is actually local. */
const biggest = (d?.volumes_ ?? []).slice().sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))[0];
if (biggest) {
  const peek = await volumePeek(biggest.name);
  say(peek.ok, "peek inside a volume", peek.ok
    ? `${biggest.name} via ${peek.image}: ${(peek.entries ?? []).slice(0, 3).map((e) => e.name + (e.dir ? "/" : "")).join(", ")}`
    : peek.error ?? "");
} else say(false, "peek inside a volume", "no volume to look at");

/* 4. The log stream: bytes, from a real container, within a few seconds. */
const running = ov.containers.find((c) => c.state === "running");
if (running) {
  const s = streamLogs(running.id, 3);
  if (s.ok && s.stream) {
    const reader = s.stream.getReader();
    const got = await within<{ done: boolean; value?: Uint8Array }>(6000, reader.read(), { done: true, value: undefined });
    const text = got.value ? new TextDecoder().decode(got.value) : "";
    say(text.length > 0, "the log stream delivers", `${running.name}: ${text.split("\n")[0]?.slice(0, 60) ?? ""}`);
    await reader.cancel();
  } else say(false, "the log stream opens", s.error ?? "");
} else say(false, "the log stream", "nothing is running");

/* 5. The ownership ledger, end to end: a labelled container writes to a scratch
      volume, exits, and the watcher has to have seen it. */
const ledgerDir = mkdtempSync(join(tmpdir(), "agx-live-"));
__setLedgerPath(join(ledgerDir, "owners.json"));
startVolumeWatch();
await new Promise((r) => setTimeout(r, 800));
const writer = Bun.spawn([
  "docker", "run", "--rm", "--network", "none",
  // The checkout, not the `server/` directory this is run from: the label is
  // what the ledger resolves a worktree and a branch out of, and pointing it at
  // a subdirectory makes the check report "detached" for a checkout that is on
  // a branch.
  "--label", `com.docker.compose.project.working_dir=${join(process.cwd(), "..")}`,
  "--label", "com.docker.compose.service=live-check-writer",
  "-v", `${SCRATCH_VOLUME}:/out`, "alpine:latest", "sh", "-c", "echo ok > /out/x",
], { stdout: "ignore", stderr: "ignore" });
await writer.exited;
for (let i = 0; i < 20 && !ledgerFor(SCRATCH_VOLUME); i++) await new Promise((r) => setTimeout(r, 500));
const rec = ledgerFor(SCRATCH_VOLUME);
say(!!rec?.last, "a container's write is recorded", rec?.last ? `${rec.last.worktree} · ${rec.last.branch ?? "detached"} · via ${rec.last.via}` : "nothing observed");
stopVolumeWatch();
rmSync(ledgerDir, { recursive: true, force: true });
Bun.spawnSync(["docker", "volume", "rm", SCRATCH_VOLUME], { stdout: "ignore", stderr: "ignore" });

console.log(failed ? `\n${failed} check(s) failed` : "\nall live checks passed");
process.exit(failed ? 1 : 0);
