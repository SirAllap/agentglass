import { api } from "./api.ts";
import { isJiraAvatarUrl } from "../../../shared/avatarHost.ts";

/**
 * The `src` for a person's picture from a tracker.
 *
 * A Jira picture is on a host the page's CSP does not allow, so it rides the
 * sidecar's asset proxy, the way a GitHub avatar does. Anything else (ClickUp's
 * own hosts) is already allowed and goes straight through, as before.
 */
export function avatarSrc(raw: string): string {
  return isJiraAvatarUrl(raw) ? api.prAssetUrl(raw) : raw;
}
