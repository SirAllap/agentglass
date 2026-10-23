/*
 * "Your computers": every computer on this phone, in one sheet.
 *
 * One tap on a row switches to it and closes the sheet. The "..." on the row
 * (or a long press) opens Rename and Forget in place, under that row, rather
 * than on a screen of their own: there are at most five rows and nothing else
 * to manage. Forgetting asks in the row and says who you land on.
 *
 * Add leaves for the pairing screen, which is where the camera and the
 * handshake already live; the sheet only decides whether there is room.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useAgentglass } from "../state/host-context.tsx";
import { capReached, forgetNote, nameOf, statusOf, switcherSub } from "../model/computers.ts";
import { MAX_HOSTS } from "../lib/hosts.ts";
import { Btn, Note, Sheet } from "../ui.tsx";
import { C, RADIUS, SPACE, T } from "../theme.ts";
import { Glyph } from "./glyphs.tsx";
import { CountBadge, StatusDot } from "./computer-bits.tsx";

type Menu = { id: string; mode: "menu" | "rename" | "forget" } | null;

export function ComputerSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactNode {
  const { host, hosts, live, states, waiting, switchTo, rename, forgetComputer } = useAgentglass();
  const router = useRouter();
  const [menu, setMenu] = useState<Menu>(null);
  const [draft, setDraft] = useState("");
  const list = { active: host?.id ?? null, hosts };
  const full = capReached(list);

  const close = (): void => { setMenu(null); onClose(); };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Your computers"
      footer={
        <View style={{ gap: SPACE.sm }}>
          <Btn
            label="Add computer"
            tone="primary"
            disabled={full}
            onPress={() => { close(); router.push("/pair"); }}
          />
          {full ? <Note>This phone can watch at most {MAX_HOSTS} computers. Forget one to add another.</Note> : null}
        </View>
      }
    >
      <View style={{ gap: SPACE.sm }}>
        {hosts.map((h) => {
          const status = statusOf(h, h.id === host?.id, live, states[h.id]);
          const waits = waiting[h.id] ?? 0;
          const mine = menu?.id === h.id ? menu.mode : null;
          return (
            <View key={h.id} style={{ borderRadius: RADIUS.md, backgroundColor: C.bg2, borderWidth: 1, borderColor: C.border }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: h.id === host?.id }}
                  accessibilityLabel={`${nameOf(h)}, ${switcherSub(status, waits)}`}
                  onPress={() => { void switchTo(h.id); close(); }}
                  onLongPress={() => setMenu(mine ? null : { id: h.id, mode: "menu" })}
                  style={({ pressed }) => ({
                    flex: 1, minHeight: 72, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                    paddingLeft: SPACE.lg, backgroundColor: pressed ? C.bg3 : "transparent",
                    borderRadius: RADIUS.md,
                  })}
                >
                  <StatusDot status={status} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>{nameOf(h)}</Text>
                    <Text numberOfLines={1} style={{ color: status === "removed" ? C.error : C.text3, fontSize: T.small }}>
                      {switcherSub(status, waits)}
                    </Text>
                  </View>
                  {h.id !== host?.id && status === "online" && waits > 0 ? <CountBadge n={waits} /> : null}
                  {h.id === host?.id ? <Glyph name="check" color={C.primary} size={22} /> : null}
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`More for ${nameOf(h)}`}
                  onPress={() => setMenu(mine ? null : { id: h.id, mode: "menu" })}
                  style={{ width: 48, height: 72, alignItems: "center", justifyContent: "center" }}
                >
                  <Glyph name="more" color={C.text2} size={22} />
                </Pressable>
              </View>

              {mine === "menu" ? (
                <View style={{ flexDirection: "row", gap: SPACE.sm, padding: SPACE.md, paddingTop: 0 }}>
                  <Btn label="Rename" style={{ flex: 1 }} onPress={() => { setDraft(h.name ?? nameOf(h)); setMenu({ id: h.id, mode: "rename" }); }} />
                  <Btn label="Forget" style={{ flex: 1 }} onPress={() => setMenu({ id: h.id, mode: "forget" })} />
                </View>
              ) : null}

              {mine === "rename" ? (
                <View style={{ gap: SPACE.sm, padding: SPACE.md, paddingTop: 0 }}>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel="Name"
                    placeholderTextColor={C.text4}
                    placeholder={nameOf(h)}
                    onSubmitEditing={() => { void rename(h.id, draft); setMenu(null); }}
                    style={{
                      minHeight: 48, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.md,
                      backgroundColor: C.bg, color: C.text, paddingHorizontal: SPACE.md, fontSize: T.body,
                    }}
                  />
                  <Note>Only changes how this phone shows it. The computer keeps its own name.</Note>
                  <View style={{ flexDirection: "row", gap: SPACE.sm }}>
                    <Btn label="Cancel" style={{ flex: 1 }} onPress={() => setMenu(null)} />
                    <Btn label="Save" tone="primary" style={{ flex: 1 }} onPress={() => { void rename(h.id, draft); setMenu(null); }} />
                  </View>
                </View>
              ) : null}

              {mine === "forget" ? (
                <View style={{ gap: SPACE.sm, padding: SPACE.md, paddingTop: 0 }}>
                  <Note>
                    This phone drops its key for {nameOf(h)} and stops alerting from it. {forgetNote(list, h.id, nameOf)}
                  </Note>
                  <Note>The key stays allowed at the computer until somebody removes this phone there.</Note>
                  <View style={{ flexDirection: "row", gap: SPACE.sm }}>
                    <Btn label="Keep it" style={{ flex: 1 }} onPress={() => setMenu(null)} />
                    <Btn
                      label="Forget"
                      tone="danger"
                      style={{ flex: 1 }}
                      onPress={() => { void forgetComputer(h.id); setMenu(null); if (hosts.length <= 1) close(); }}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </Sheet>
  );
}
