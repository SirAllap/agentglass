/*
 * Open a linked pull request in the app, and in the browser only if the
 * computer has no checkout of it. See model/prRef.ts for why.
 */
import type { useRouter } from "expo-router";
type Router = ReturnType<typeof useRouter>;
import { ask } from "../lib/api.ts";
import { openHttp } from "../lib/openHttp.ts";
import type { Host } from "../lib/host.ts";
import { prRef, repoOf } from "../model/prRef.ts";

/** `here` is a checkout the caller already has for a known repository — an
 *  issue's own — so a pull request in the same repository costs no lookup. */
export async function openLinkedPr(
  host: Host,
  router: Router,
  url: string,
  here?: { repo: string | null; root: string },
): Promise<void> {
  const ref = prRef(url);
  if (!ref) { openHttp(url); return; }
  let root = here && here.repo && here.repo === repoOf(url) ? here.root : null;
  if (!root) {
    const answer = await ask<{ ok: boolean; root?: string }>(host, `/prs/locate?repo=${encodeURIComponent(ref.repo)}`);
    root = answer.ok && answer.value.ok && answer.value.root ? answer.value.root : null;
  }
  if (!root) { openHttp(url); return; }
  router.push({ pathname: "/pr/[number]", params: { number: String(ref.number), root } });
}
