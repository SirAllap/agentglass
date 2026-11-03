import type { DockerOverview } from "../../../shared/types.ts";
import { api } from "./api.ts";
import { IS_DEMO } from "./demo.ts";
import { setRailTip } from "./railTips.ts";

/**
 * How many containers are running, for the Docker button's tooltip.
 *
 * No poll: the count is read when the pointer or focus reaches the button, and
 * a good answer is trusted for 30 s. DockerPanel writes its fresh result here
 * while it is open. A failure is remembered for 5 s only, so a daemon that was
 * still starting is picked up on the next hover. Ceiling: up to 30 s stale.
 */
const TTL_MS = 30_000;
const FAIL_MS = 5_000;

let at = 0;
let ttl = 0;
let good = false;
let inflight: Promise<void> | null = null;

/** Paused, restarting and exited are not running. No docker or an error: no tip. */
export function runningText(o: Pick<DockerOverview, "available" | "error" | "containers">): string | null {
  if (!o.available || o.error) return null;
  const n = o.containers.filter((c) => c.state === "running").length;
  return n === 0 ? "Docker · nothing running" : `Docker · ${n} running`;
}

/** What DockerPanel saw. An error never replaces a good count inside its TTL. */
export function noteOverview(o: DockerOverview | null): void {
  const text = o ? runningText(o) : null;
  const now = Date.now();
  if (text === null && good && now - at < ttl) return;
  good = text !== null;
  at = now;
  ttl = good ? TTL_MS : FAIL_MS;
  setRailTip("docker", text);
}

export function warm(): Promise<void> {
  if (IS_DEMO) return Promise.resolve();
  if (inflight) return inflight;
  if (at && Date.now() - at < ttl) return Promise.resolve();
  inflight = api.dockerOverview().then(noteOverview, () => noteOverview(null)).finally(() => { inflight = null; });
  return inflight;
}

/** Test seam: forget everything. */
export function resetDockerCount(): void {
  at = 0; ttl = 0; good = false; inflight = null;
  setRailTip("docker", null);
}
