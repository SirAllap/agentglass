/*
 * The diff, as a route.
 *
 * The screen itself is `src/review/FilesPane.tsx`. This file exists because a
 * notification can point at a file of a pull request, and a link that used to
 * open a screen must go on opening one — the pane is also the Files segment of
 * the review, and the two must be the same thing rather than two screens that
 * drift apart.
 */
import { Stack, useLocalSearchParams } from "expo-router";
import { FilesPane } from "../../src/review/FilesPane.tsx";

export default function DiffScreen(): React.ReactNode {
  const { number, root, path } = useLocalSearchParams<{
    number: string; root: string; path?: string;
  }>();
  return (
    <>
      <Stack.Screen options={{ title: `#${number} · files` }} />
      <FilesPane number={number ?? ""} root={root ?? ""} path={path} />
    </>
  );
}
