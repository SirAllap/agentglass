/*
 * Which task trackers this computer has, and why the Cards tab is or is not
 * showing. A diagnosis and never a setup: a phone cannot connect a tracker, so
 * every reason that is not "connected" ends in where to do it.
 */
import { ScrollView } from "react-native";
import { Stack } from "expo-router";
import { trackerRows } from "../src/model/trackerRows.ts";
import { Glyph } from "../src/nav/glyphs.tsx";
import { useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { useProviders } from "../src/state/use-tracks-work.ts";
import { Chip, Group, Note, Row } from "../src/ui.tsx";
import { C, SPACE } from "../src/theme.ts";

export default function TrackersScreen(): React.ReactNode {
  usePaletteTick();
  const { host } = useAgentglass();
  const rows = trackerRows(useProviders(host));
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.md, paddingBottom: SPACE.xl }}>
      <Stack.Screen options={{ title: "Task trackers" }} />
      <Group inset={50}>
        {rows.map((r) => (
          <Row
            key={r.id}
            title={r.title}
            sub={r.reason}
            lead={<Glyph name="list" color={r.badge === "soon" ? C.text4 : C.text2} size={20} />}
            trail={<Chip label={r.badge} tone={r.badge === "on" ? "good" : "neutral"} />}
          />
        ))}
      </Group>
      <Note>
        The Cards tab shows up on its own when a tracker is connected on the computer. Nothing here
        changes that; this list only says why the tab is missing.
      </Note>
    </ScrollView>
  );
}
