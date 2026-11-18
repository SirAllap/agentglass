/*
 * The agents roster: what the computer says is running, and what each one last
 * said — with no switch anywhere on it.
 *
 * Starting an agent is a window on somebody's computer, and this phone already
 * has a terminal that does that properly. So this is a READ: the same rows the
 * Inbox's agent source reads (`model/inbox.ts`), given a word each, and one door
 * out to the terminal for anything you want to do about them.
 *
 * The three states worth seeing are the three the desk's strip uses — working,
 * finished, stopped on you — because a person who has learnt to read the desk
 * should not have to learn a second vocabulary in their hand. The order puts
 * "waiting for you" first: a list of twelve agents whose first row is idle hides
 * the row that is stopped on a permission prompt.
 */
import { Text, View } from "react-native";
import { agentRoster, rosterFoot } from "../model/inbox.ts";
import type { StoppedAgent } from "../model/inbox.ts";
import { Btn, Chip, Note, Sheet, type ChipTone } from "../ui.tsx";
import { C, SPACE, T } from "../theme.ts";

const TONE: Record<string, ChipTone> = {
  waiting: "bad",
  left: "warn",
  quiet: "neutral",
  working: "accent",
  finished: "good",
};

export function AgentsSheet({ open, onClose, agents, loading, onTerminal }: {
  open: boolean;
  onClose: () => void;
  agents: readonly StoppedAgent[];
  /** The first read has not answered yet — an empty roster is not "no agents". */
  loading: boolean;
  onTerminal: () => void;
}): React.ReactNode {
  const lines = agentRoster(agents);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Agents"
      subtitle="A read-only view from the Terminal"
      tall
      footer={<Btn label="Open the Terminal" tone="primary" onPress={onTerminal} style={{ flex: 1 }} />}
    >
      <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
        <Note>This view cannot start or stop anything. Starting an agent is a window on the computer.</Note>
        {loading ? (
          <Text style={{ color: C.text3, fontSize: T.body }}>Asking the computer…</Text>
        ) : lines.length === 0 ? (
          <Text style={{ color: C.text3, fontSize: T.body }}>No agent has reported in this hour.</Text>
        ) : (
          <View style={{ gap: SPACE.sm }}>
            {lines.map((line) => (
              <View
                key={line.id}
                accessibilityLabel={`${line.name}: ${line.word}, ${line.said}`}
                style={{ paddingVertical: SPACE.sm, gap: 3, borderBottomWidth: 1, borderBottomColor: C.border }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "600", flex: 1 }}>
                    {line.where ? `${line.name} · ${line.where}` : line.name}
                  </Text>
                  <Chip label={line.word} tone={TONE[line.mood] ?? "neutral"} />
                </View>
                <Text numberOfLines={2} style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>{line.said}</Text>
              </View>
            ))}
          </View>
        )}
        <Text style={{ color: C.text2, fontSize: T.small }}>{rosterFoot(lines)}</Text>
        <Text style={{ color: C.text3, fontSize: T.small }}>
          Every state is also a tab in the Terminal.
        </Text>
      </View>
    </Sheet>
  );
}
