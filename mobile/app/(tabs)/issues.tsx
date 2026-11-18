/*
 * The Issues route, kept alive as a redirect.
 *
 * Issues are a source inside Tasks now (see src/issues/IssueList.tsx for the
 * list itself). The route stays because a link or a notification made before
 * the move still lands on `/issues`, and a route that 404s is a dead end with
 * no way back from the device looking at it.
 *
 * Not a screen: it draws nothing and forwards. `test/nav.test.ts` knows it by
 * name in OFF_BAR, with this sentence as its way in.
 */
import { Redirect } from "expo-router";

export default function IssuesScreen(): React.ReactNode {
  return <Redirect href="/tasks?source=issues" />;
}
