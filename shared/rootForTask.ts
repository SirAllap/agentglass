/**
 * Which checkout a card's repository lives in: the one named like its list
 * (`Orbit Sprint` does not match, `orbit` does), else the fallback. Shared by
 * the desktop and the phone, which both ask `/clickup/prs` where to search.
 */
export function rootForTask(
  project: string | null, repos: { root: string; name: string }[], fallback: string | null,
): string | null {
  const want = (project ?? "").trim().toLowerCase();
  if (want) {
    const tail = want.split(".").pop()!;
    const hit = repos.find((r) => r.name.toLowerCase() === want)
      ?? repos.find((r) => r.name.toLowerCase() === tail);
    if (hit) return hit.root;
  }
  return fallback || null;
}
