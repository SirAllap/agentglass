import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ask } from "../lib/api.ts";
import { useAgentglass } from "../state/host-context.tsx";
import { usePaletteTick } from "../state/use-palette.ts";
import { useInbox } from "../state/use-inbox.ts";
import { gatesInOrder } from "../model/gates.ts";
import { statusOf as computerStatus } from "../model/computers.ts";
import { Glyph } from "../nav/glyphs.tsx";
import { SettingsIcon } from "../nav/icons.tsx";
import { StatusDot as ComputerDot } from "../nav/computer-bits.tsx";
import { Chip, Note, TAP } from "../ui.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";
import { leafOf } from "./windows.ts";
import { GateCard } from "./GateCard.tsx";
import { SettingsRequestList } from "./SettingsRequestCard.tsx";
import { DoorRow } from "./DoorRow.tsx";
import { TerminalDoors } from "./Doors.tsx";
import type { DeviceScope, GitRepoRef } from "../../../shared/types.ts";

/**
 * What a phone that may not type sees instead of a pane that cannot open.
 *
 * The destination stays in the bar for every pairing, because "what are the
 * agents doing, and is one waiting on me" is a question every pairing asks. The
 * mock draws this phone as a page of doors rather than a card explaining
 * itself: a banner that names the pairing, the gate waiting on an `answer`
 * phone, and Files / Source control / Inbox — every one of them still open,
 * and the ones that write marked `read`.
 *
 * The keys and the composer are GONE, not greyed: a field that cannot send is a
 * promise the phone cannot keep. `read` does not get the gate card, and that is
 * a decision against the drawing: the button it puts there answers a gate, and
 * `/gate/decide` needs `answer` (server/src/auth.ts, ANSWER_POST). A drawn
 * button the server refuses is worse than a sentence saying which grant opens
 * it — see the note at the foot of this screen.
 */
export function TerminalRefused({ scope }: { scope: DeviceScope }): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host, fleet, refresh, live } = useAgentglass();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const gates = gatesInOrder(fleet.gates);
  const answers = scope === "answer";
  const { count } = useInbox(host, fleet);
  /* Which checkout Files and Source control are for. One read, and the first
     repository is what "this checkout" means to a phone that has never
     attached a pane. */
  const [project, setProject] = useState<GitRepoRef | null>(null);
  useEffect(() => {
    if (!host) return;
    let gone = false;
    void (async () => {
      const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
      if (gone) return;
      setProject(answer.ok ? answer.value.repos?.[0] ?? null : null);
    })();
    return () => { gone = true; };
  }, [host]);
  const root = project?.root;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={{
        flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: SPACE.xs,
        borderBottomWidth: 1, borderBottomColor: C.border,
      }}>
        <View style={{
          flex: 1, minWidth: 0, minHeight: TAP, flexDirection: "row", alignItems: "center",
          gap: SPACE.sm, paddingHorizontal: SPACE.xs,
        }}>
          <ComputerDot status={host ? computerStatus(host, true, live) : "checking"} colors={C} />
          <Text numberOfLines={1} ellipsizeMode="head" style={{ color: C.text, fontSize: T.title, fontWeight: "600", flexShrink: 1 }}>
            {project?.name || "Terminal"}
          </Text>
        </View>
        <Chip label="Read-only" tone="neutral" icon={<Glyph name="eye" color={C.text2} size={13} />} />
        <Pressable
          onPress={() => router.push("/settings")}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          style={({ pressed }) => ({
            width: TAP, height: TAP, marginLeft: SPACE.xs, alignItems: "center", justifyContent: "center",
            borderRadius: RADIUS.md, backgroundColor: pressed ? C.bg3 : "transparent",
          })}
        >
          <SettingsIcon color={C.text2} size={22} />
        </Pressable>
      </View>

      <TerminalDoors
        colors={C}
        doors={[
          {
            glyph: "folder", label: `Files in ${root ? leafOf(root) : "this checkout"}`,
            onPress: root ? () => router.push({ pathname: "/files", params: { root } }) : undefined,
          },
          {
            glyph: "branch", label: `Source control in ${root ? leafOf(root) : "this checkout"}`,
            onPress: root ? () => router.push({ pathname: "/repos", params: { root } }) : undefined,
          },
          { glyph: "history", label: "Past sessions", onPress: () => router.push({ pathname: "/sessions", params: { root: root ?? "" } }) },
          { glyph: "bot", label: "Agents on this computer", onPress: () => router.push({ pathname: "/agents", params: { root: root ?? "" } }) },
        ]}
      />

      <ScrollView contentContainerStyle={{ padding: SPACE.md, paddingBottom: SPACE.xl, gap: SPACE.md }}>
        <View style={{
          flexDirection: "row", gap: SPACE.sm, padding: SPACE.md, borderRadius: RADIUS.lg,
          backgroundColor: tint(C.primary, 0.12),
        }}>
          <Glyph name="lock" color={C.primary} size={17} />
          <Text style={{ flex: 1, color: C.primary, fontSize: T.small, lineHeight: 18 }}>
            <Text style={{ fontWeight: "700" }}>{answers ? "This phone can answer, not type." : "This phone can look, not type."}</Text>
            {" "}Chosen at the computer in Remote access. Files and Source control stay open, both read-only.
          </Text>
        </View>

        {answers ? (
          <View style={{ gap: SPACE.sm }}>
            <Text style={{ color: C.text2, fontSize: T.body, fontWeight: "600" }}>
              {gates.length ? `Waiting on you · ${gates.length}` : "Nothing is waiting on you"}
            </Text>
            {gates.map((gate) => (
              <GateCard key={gate.id} gate={gate} host={host!} colors={C} onDone={refresh} />
            ))}
            {host ? <SettingsRequestList host={host} colors={C} tick={fleet.at} onDone={refresh} /> : null}
          </View>
        ) : null}

        <View style={{ borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border, overflow: "hidden" }}>
          <DoorRow
            glyph="folder"
            title="Files for this checkout"
            sub={project ? `Read-only · ${project.name}` : "Read-only · no project paired"}
            tag="read"
            onPress={root ? () => router.push({ pathname: "/files", params: { root } }) : undefined}
          />
          <DoorRow
            glyph="branch"
            title="Source control for this checkout"
            sub="Read-only · Changes, Log, Branches"
            tag="read"
            onPress={root ? () => router.push({ pathname: "/repos", params: { root } }) : undefined}
          />
          <DoorRow
            glyph="bell"
            title="Inbox"
            sub={count ? `${count} thing${count === 1 ? "" : "s"} waiting · answered here` : "Nothing is waiting on you"}
            onPress={() => router.push("/inbox")}
          />
        </View>

        <Note>
          The keys and the composer are gone, not greyed: a field that cannot send is a promise the
          phone cannot keep.{answers ? "" : " Typing and answering a gate need the full or answer grant, chosen at the computer when a phone is paired."}
        </Note>
      </ScrollView>
    </View>
  );
}
