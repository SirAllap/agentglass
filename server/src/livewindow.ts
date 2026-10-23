// "Is Claude already working in the window this button would open?"
//
// A window the app names itself (`conflict-1042`) is looked for by exact name,
// and by WHICH repository it sits in: two repositories can both have a pull
// request 1042, and the other one's window is not this one's. The repository is
// the project a pane's directory rolls up to, so a linked worktree of the same
// repository counts and a clone of another does not.
import { projectRootOfAsync } from "./git.ts";
import { engineWindowName, liveWindows, samePlace, type LiveWindow } from "./tmuxpane.ts";

export async function findLiveWindow(q: { root: string; name: string; path?: string }): Promise<LiveWindow | null> {
  const name = engineWindowName(q.name);
  if (!name) return null;
  const named = (await liveWindows()).filter((w) => w.name === name && (!q.path || samePlace(w.path, q.path)));
  if (!named.length) return null;
  const project = await projectRootOfAsync(q.root);
  if (!project) return null;
  for (const w of named) if ((await projectRootOfAsync(w.path)) === project) return w;
  return null;
}
