/**
 * Which lane this window hosts, from `#lane=<id>`, or null for the app itself.
 *
 * A lane host is a window nobody sees (electron/main.js, createLaneHost). It
 * loads the same bundle, and this is the one question that decides whether it
 * mounts the whole app or only a webview for an agent to drive. The id is
 * short and plain on purpose: it names a window, and anything else in the
 * hash is not a lane.
 */
export function laneFromHash(hash: string): string | null {
  return LANE_HASH.exec(hash)?.[1] ?? null;
}

const LANE_HASH = /^#lane=([A-Za-z0-9_-]{1,64})(?:&p=([a-z0-9]{1,16}))?$/;

/**
 * The container a lane browses in, from the same hash: the profile id after
 * `&p=`, or "" (the person's own container) when there is none. A private lane
 * names its own id there, so the jar is its alone.
 */
export function laneProfileFromHash(hash: string): string {
  return LANE_HASH.exec(hash)?.[2] ?? "";
}
