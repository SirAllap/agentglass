/*
 * The card a task link points at, when the phone can draw it itself.
 *
 * `/card/[id]` asks `/clickup/task?id=`, which takes the plain task id and
 * nothing team-qualified, so only the `/t/<id>` shape is a card here. A
 * custom id in a team-qualified link is left to the browser rather than sent
 * to a route that would answer "not found" for something that exists.
 */
export function cardIdFromUrl(url: string | null | undefined): string | null {
  const m = /^https:\/\/app\.clickup\.com\/t\/([A-Za-z0-9]+)\/?(?:[?#].*)?$/.exec(url ?? "");
  return m ? m[1]! : null;
}
