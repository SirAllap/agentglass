/*
 * One Jira card's route. Thin on purpose: the router's param is untrusted, a
 * key is checked against the shape Jira hands out, and the screen behind it
 * (`src/jira/Card.tsx`) reads and draws.
 */
import { View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { ComputerGone } from "../../src/nav/ComputerGone.tsx";
import { isJiraKey } from "../../src/model/jiraCard.ts";
import { JiraCard } from "../../src/jira/Card.tsx";
import { Card, Label, Note } from "../../src/ui.tsx";
import { SPACE } from "../../src/theme.ts";

export default function JiraCardRoute(): React.ReactNode {
  const { key } = useLocalSearchParams<{ key?: string }>();
  const cardKey = typeof key === "string" ? key : "";
  return (
    <ComputerGone>
      {/* The card draws its own header — the key, the board and epic under it,
          the bell, and the way out to Jira — because the native one could only
          carry the key on one line and nothing beside it. */}
      <Stack.Screen options={{ title: isJiraKey(cardKey) ? cardKey.toUpperCase() : "Jira card", headerShown: !isJiraKey(cardKey) }} />
      {isJiraKey(cardKey) ? (
        <JiraCard cardKey={cardKey.toUpperCase()} />
      ) : (
        <View style={{ padding: SPACE.lg }}>
          <Card>
            <Label text="Not a Jira card" />
            <Note tone="bad">That address does not name a card Jira could have. Open it again from the board.</Note>
          </Card>
        </View>
      )}
    </ComputerGone>
  );
}
