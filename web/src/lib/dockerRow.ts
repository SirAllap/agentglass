/*
 * The small decisions a Docker row makes, out of the component.
 *
 * A row now has four things to say that it did not have before — the checkout
 * it came from, whether its health check is failing and why, the port you can
 * actually open, and how old the whole picture is — and each of them is a
 * judgement call about colour and wording. Here rather than inline because
 * these are the parts worth pinning with a test: a row that calls a sibling
 * worktree's container "yours" is worse than one that says nothing.
 */
import type { DockerContainer, DockerOwnerRef } from "../../../shared/types.ts";

export { portLabel, portUrl, firstReachable } from "../../../shared/dockerPort.ts";

/**
 * The colour a health state earns.
 *
 * `null` — no health check declared — gets nothing at all. Most containers are
 * in that state, and painting them would make the colour mean "container"
 * instead of "look at this".
 */
export function healthTint(health: DockerContainer["health"]): string | null {
  switch (health) {
    case "unhealthy": return "var(--error)";
    case "starting": return "var(--warning)";
    case "healthy": return "var(--success)";
    default: return null;
  }
}

/** What the health chip says. Short enough for a row; the probe's own words go
 *  in the title, because they are the half that tells you what to do. */
export function healthLabel(c: DockerContainer): string | null {
  if (!c.health) return null;
  if (c.health === "unhealthy") return c.healthFailures && c.healthFailures > 1 ? `unhealthy · ${c.healthFailures}` : "unhealthy";
  return c.health === "starting" ? "starting" : "healthy";
}

/**
 * The owner chip's colour: neutral for yours, amber for somebody else's.
 *
 * Amber and not red on purpose. A container from another worktree is not
 * broken — it is running exactly as intended, just not from the checkout you
 * have open — and red is for things that need fixing.
 */
export const ownerTint = (owner: DockerOwnerRef | undefined): string =>
  owner?.foreign ? "var(--warning)" : "var(--text3)";

/** The full story for a tooltip: which checkout, which branch, and the path,
 *  since two checkouts can share a leaf name in different parents. */
export function ownerTitle(owner: DockerOwnerRef | undefined): string {
  if (!owner) return "";
  const where = owner.foreign ? "another worktree" : "this project";
  return [`${owner.worktree} — ${where}`, owner.branch ? `branch ${owner.branch}` : "detached HEAD", owner.path].join("\n");
}

/**
 * How old the picture is, in words.
 *
 * Seconds while it is seconds, because that is the range where the answer
 * matters: past a minute the point is no longer "how stale" but "something is
 * wrong", and the freshness state says that instead.
 */
export function freshnessLabel(at: number | undefined, now = Date.now()): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** What the header says next to the age, when the data is not simply live. */
export function freshnessNote(state: DockerOverview_["freshness"], tookMs?: number): string | null {
  switch (state) {
    case "retrying": return "no answer from docker — retrying";
    // A gather that took a while is worth naming: it is the difference between
    // a daemon that is gone and one that is merely busy, and the second one
    // resolves itself if you wait.
    case "stale": return tookMs && tookMs > 1500 ? "docker is slow to answer" : null;
    case "down": return "docker is not answering";
    default: return null;
  }
}
type DockerOverview_ = import("../../../shared/types.ts").DockerOverview;
