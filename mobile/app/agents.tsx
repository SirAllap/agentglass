/*
 * Agents: what the computer says is running, and what each one last said.
 *
 * A pushed screen rather than a sheet, because it is a view somebody reads on
 * the way to something else and the mock draws it as a page: a banner saying
 * what it cannot do, the roster, and one door back to the terminal. The rows
 * are the Inbox's own (`agentRoster`), so the two lists and the bell cannot
 * disagree about how many agents are waiting.
 *
 * Read-only by construction: there is no switch on this screen, and the only
 * write it can reach is the terminal's — where starting an agent is a window
 * on somebody's computer, which is a decision for the desk.
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { GitRepoRef } from "../../shared/types.ts";
import { agentRoster, rosterFoot, type AgentMood } from "../src/model/inbox.ts";
import { ask } from "../src/lib/api.ts";
import { displayName } from "../src/model/computers.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { useComputer } from "../src/state/use-computer.ts";
import { useInbox } from "../src/state/use-inbox.ts";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { leafOf } from "../src/terminal/windows.ts";
import { ChevronIcon } from "../src/nav/icons.tsx";
import { Glyph, type GlyphName } from "../src/nav/glyphs.tsx";
import { Chip, Note, TAP, type ChipTone } from "../src/ui.tsx";
import { C, RADIUS, SPACE, T, tint } from "../src/theme.ts";

const LEAD: Record<AgentMood, { glyph: GlyphName; color: string; tone: ChipTone }> = {
  working: { glyph: "bot", color: C.primary, tone: "accent" },
  finished: { glyph: "check", color: C.success, tone: "good" },
  waiting: { glyph: "alert", color: C.warning, tone: "warn" },
  left: { glyph: "clock", color: C.warning, tone: "warn" },
  quiet: { glyph: "clock", color: C.text3, tone: "neutral" },
};

export default function AgentsScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { host, fleet } = useAgentglass();
  const { agents, loading } = useInbox(host, fleet);
  const said = useComputer(host);
  const computer = host ? displayName(host, said) : "This computer";
  const params = useLocalSearchParams<{ root?: string }>();
  const [project, setProject] = useState<string | null>(null);
  const lines = agentRoster(agents);
  const urgent = lines[0];

  /* The subtitle's other half. The route says which checkout this was opened
     from; a cold start falls back to the first project. */
  useEffect(() => {
    if (!host) return;
    let gone = false;
    void (async () => {
      const named = params.root;
      if (named) {
        const answer = await ask<{ repo: GitRepoRef }>(host, `/git/repo?root=${encodeURIComponent(named)}`);
        if (gone) return;
        const repo = answer.ok ? answer.value.repo : undefined;
        const main = repo?.worktreeOf ?? repo?.root ?? named;
        setProject(leafOf(main));
        return;
      }
      const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
      if (gone) return;
      const first = answer.ok ? answer.value.repos?.[0]?.root : undefined;
      if (first) setProject(leafOf(first));
    })();
    return () => { gone = true; };
  }, [host, params.root]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={{
        flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: SPACE.xs,
        borderBottomWidth: 1, borderBottomColor: C.border,
      }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => ({
            width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
            borderRadius: RADIUS.md, backgroundColor: pressed ? C.bg3 : "transparent",
          })}
        >
          <View style={{ transform: [{ rotate: "180deg" }] }}><ChevronIcon color={C.text} size={20} /></View>
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, paddingLeft: SPACE.xs }}>
          <Text numberOfLines={1} style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>Agents</Text>
          <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
            {project ? `${computer} · ${project}` : computer}
          </Text>
        </View>
        {/* The pairing, said once and in a chip: this screen cannot start or
            stop anything, and that is a permission, not a bug. */}
        <View style={{
          flexDirection: "row", alignItems: "center", gap: SPACE.xs, height: 28,
          paddingHorizontal: SPACE.sm, borderRadius: RADIUS.sm, borderWidth: 1, borderColor: C.border2,
        }}>
          <Glyph name="eye" color={C.text2} size={13} />
          <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600" }}>Read-only</Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: SPACE.md, paddingBottom: SPACE.xl, gap: SPACE.md }}
      >
        <View style={{
          flexDirection: "row", gap: SPACE.sm, padding: SPACE.md, borderRadius: RADIUS.lg,
          backgroundColor: tint(C.primary, 0.12),
        }}>
          <Glyph name="bot" color={C.primary} size={18} />
          <Text style={{ flex: 1, color: C.primary, fontSize: T.small, lineHeight: 18 }}>
            <Text style={{ fontWeight: "700" }}>This view cannot start or stop anything.</Text>
            {" "}Starting an agent is a window on the computer; here you see which are running and what they last said.
          </Text>
        </View>

        {loading && !lines.length ? (
          <Note>Asking the computer…</Note>
        ) : lines.length === 0 ? null : (
          <View style={{
            borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
            backgroundColor: C.bg2, overflow: "hidden",
          }}>
            {lines.map((line, index) => {
              const lead = LEAD[line.mood];
              return (
                <View
                  key={line.id}
                  accessibilityLabel={`${line.name}: ${line.word}, ${line.said}`}
                  style={{
                    flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm,
                    padding: SPACE.md,
                    borderTopWidth: index ? 1 : 0, borderTopColor: C.border,
                  }}
                >
                  <View style={{
                    width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center",
                    backgroundColor: tint(lead.color, 0.14),
                  }}>
                    <Glyph name={lead.glyph} color={lead.color} size={16} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>
                      {line.where ? `${line.name} · ${line.where}` : line.name}
                    </Text>
                    <Text numberOfLines={2} style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>
                      {line.said}
                    </Text>
                  </View>
                  <Chip label={line.word} tone={lead.tone} />
                </View>
              );
            })}
          </View>
        )}

        <Text style={{ color: C.text3, fontSize: T.small }}>
          {rosterFoot(lines)} Every state is also a tab in the Terminal.
        </Text>

        {urgent ? (
          <Pressable
            onPress={() => router.push("/terminal")}
            accessibilityRole="button"
            accessibilityLabel={`Open ${urgent.name} on the computer`}
            style={({ pressed }) => ({
              minHeight: TAP, flexDirection: "row", alignItems: "center", justifyContent: "center",
              gap: SPACE.sm, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
              backgroundColor: pressed ? C.bg3 : "transparent",
            })}
          >
            <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>
              {`Open ${urgent.name} on the computer`}
            </Text>
            <Glyph name="external" color={C.text2} size={17} />
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
